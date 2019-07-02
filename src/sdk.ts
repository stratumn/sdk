import { sig } from '@stratumn/js-crypto';
import {
  SdkOptions,
  SdkConfig,
  NewTraceInput,
  isPrivateKeySecret,
  AppendLinkInput,
  TraceState,
  PushTransferInput,
  PullTransferInput,
  TransferResponseInput,
  GetTraceStateInput,
  GetTraceDetailsInput,
  TraceDetails,
  PaginationInfo,
  TraceStageType,
  TracesState
} from './types';
import {
  ConfigQuery,
  CreateLinkMutation,
  GetHeadLinkQuery,
  GetTraceStateQuery,
  GetTraceDetailsQuery,
  GetTracesInStageQuery,
  Fragments
} from './graphql';
import { Client } from './client';
import { TraceLinkBuilder } from './traceLinkBuilder';
import { fromObject, TraceLink } from './traceLink';

/**
 * The Stratumn javascript Sdk
 */
export class Sdk<TState = any> {
  /**
   * The Sdk options
   */
  private opts: SdkOptions;

  /**
   * The underlying REST / GraphQL client
   */
  private client: Client;

  /**
   * The config object for the given workflow
   */
  private config?: SdkConfig;

  /**
   * Constructs a new instance of the Sdk
   * @param opts the Sdk options
   */
  constructor(opts: SdkOptions) {
    this.opts = opts;
    this.client = new Client(opts);
  }

  /*********************************************************
   *                   private methods                     *
   *********************************************************/

  /**
   * Retrieves the Sdk config for the given workflow.
   * If the config has not yet been computed, the Sdk will
   * run a GraphQL query to retrieve the relevant info
   * and will generate the config.
   *
   * @returns the Sdk config object
   */
  private async getConfig(): Promise<SdkConfig> {
    // if the config already exists use it!
    if (this.config) {
      return this.config;
    }

    // extract the workflow id from the options
    const { workflowId } = this.opts;

    // shortcut types
    type Response = ConfigQuery.Response;
    type Variables = ConfigQuery.Variables;

    // run the GraphQL ConfigQuery
    const rsp = await this.client.graphql<Response, Variables>(
      ConfigQuery.document,
      { workflowId }
    );

    // extract relevant info from the response
    const {
      account: {
        userId,
        accountId,
        memberOf,
        account: {
          signingKey: { privateKey }
        }
      },
      workflow
    } = rsp;

    if (!workflow || !workflow.groups) {
      throw new Error(`Cannot find workflow ${workflowId}`);
    }

    const { groups } = workflow;

    // get all the account ids I am a member of
    const myAccounts = memberOf.nodes.map(a => a.accountId);

    // get all the groups that are owned by one of my accounts
    const myGroups = groups.nodes.filter(g => myAccounts.includes(g.accountId));

    // there must be at most one group!
    if (myGroups.length > 1) {
      throw new Error('More than one group to choose from.');
    }
    // there must be at least one group!
    if (myGroups.length === 0) {
      throw new Error('No group to choose from.');
    }

    // extract info from my only group
    const [{ groupId, accountId: ownerId }] = myGroups;

    // retrieve the signing private key
    let signingPrivateKey: sig.SigningPrivateKey;
    if (isPrivateKeySecret(this.opts.secret)) {
      // if the secret is a PrivateKeySecret, use it!
      signingPrivateKey = new sig.SigningPrivateKey({
        pemPrivateKey: this.opts.secret.privateKey
      });
    } else if (!privateKey.passwordProtected) {
      // otherwise use the key from the response
      // if it's not password protected!
      signingPrivateKey = new sig.SigningPrivateKey({
        pemPrivateKey: privateKey.decrypted
      });
    } else {
      throw new Error('Cannot get signing private key');
    }

    // store the new config
    this.config = {
      workflowId,
      userId,
      accountId,
      groupId,
      ownerId,
      signingPrivateKey
    };

    // return the new config
    return this.config;
  }

  /**
   * Builds the TraceState object from the TraceState fragment response
   *
   * @param trace the trace fragment response
   * @returns the trace state
   */
  private makeTraceState(trace: Fragments.TraceState.Response) {
    // retrieve parent link
    const headLink = fromObject(trace.head.raw);

    // build the TraceState object
    const state: TraceState<TState> = {
      traceId: headLink.traceId(),
      headLink,
      updatedAt: new Date(trace.updatedAt),
      updatedBy: headLink.createdBy(),
      data: trace.state
    };
    return state;
  }

  /**
   * Creates a new Link from the given builder, signs it and
   * executes the GraphQL mutation.
   *
   * @param input the input argument to create the Link
   * @returns the new Link
   */
  private async createLink<TLinkData>(
    linkBuilder: TraceLinkBuilder<TLinkData>
  ) {
    // extract signing key from config
    const { signingPrivateKey } = await this.getConfig();

    // build the link
    const link = linkBuilder.build();

    // sign the link
    link.sign(signingPrivateKey.export(), '[version,data,meta]');

    // shortcut types
    type Response = CreateLinkMutation.Response;
    type Variables = CreateLinkMutation.Variables;

    // execute the graphql mutation
    const rsp = await this.client.graphql<Response, Variables>(
      // the graphql document
      CreateLinkMutation.document,
      // export the link as object
      { link: link.toObject({ bytes: String }) }
    );

    // build and return the TraceState object
    return this.makeTraceState(rsp.createLink.trace);
  }

  /**
   * Given a trace id or a previous link return the previous link.
   *
   * @param input.traceId the id of the trace
   * @param input.prevLink the previous link
   */
  private async getHeadLink(input: { traceId?: string; prevLink?: TraceLink }) {
    // if prevLink was provided then return it
    if (input.prevLink) {
      return input.prevLink;
    }

    // if trace id was provided, retrieve the head from api.
    if (input.traceId) {
      // shortcut types
      type Response = GetHeadLinkQuery.Response;
      type Variables = GetHeadLinkQuery.Variables;

      // execute the graphql query
      const rsp = await this.client.graphql<Response, Variables>(
        GetHeadLinkQuery.document,
        {
          traceId: input.traceId
        }
      );

      // convert the raw response to a link object
      const headLink = fromObject(rsp.trace.head.raw);

      // return the link
      return headLink;
    }
    throw new Error('Previous link or trace id must be provided');
  }

  /**
   * Get the traces in a given stage (INCOMING, OUTGOING or BACKLOG)
   * If no stage correspond to the stageType, it will throw.
   * If more than one stage is found (may happen for ATTESTATION),
   * it will also throw.
   *
   * @param stageType the stage type
   * @param paginationInfo the pagination info
   * @return the traces in a given stage
   */
  private async getTracesInStage(
    stageType: TraceStageType,
    paginationInfo: PaginationInfo
  ) {
    // extract info from config
    const { groupId } = await this.getConfig();

    // shortcut types
    type Response = GetTracesInStageQuery.Response;
    type Variables = GetTracesInStageQuery.Variables;

    // create variables
    const variables: Variables = {
      groupId,
      stageType,
      ...paginationInfo
    };

    // execute the graphql query
    const rsp = await this.client.graphql<Response, Variables>(
      GetTracesInStageQuery.document,
      variables
    );

    // get the stages from the response
    const stages = rsp.group.stages.nodes;

    // there must be exactly one stage
    if (stages.length === 1) {
      // get the stage
      const [stage] = stages;

      // extrace traces response and pagination
      const { nodes, info, totalCount } = stage.traces;

      // constructs result
      const res: TracesState<TState> = {
        traces: nodes.map(this.makeTraceState),
        info,
        totalCount
      };

      // return result
      return res;
    }

    // throw if no stages were found
    if (stages.length === 0) {
      throw new Error(`No ${stageType} stage`);
    }

    // throw if multiple stages were found
    throw new Error(`Multiple ${stageType} stages`);
  }

  /*********************************************************
   *                   public methods                      *
   *********************************************************/

  /**
   * Creates a new Trace.
   *
   * @param input  the newTrace input argument
   * @returns the new Link
   */
  public async newTrace<TLinkData>(input: NewTraceInput<TLinkData>) {
    // extract info from input
    const { data, formId } = input;

    // extract info from config
    const { workflowId, userId, ownerId, groupId } = await this.getConfig();

    // use a TraceLinkBuilder to create the first link
    const linkBuilder = new TraceLinkBuilder<TLinkData>({
      // only provide workflowId to initiate a new trace
      workflowId
    })
      // this is an attestation
      .forAttestation(formId, data)
      // add owner info
      .withOwner(ownerId)
      // add group info
      .withGroup(groupId)
      // add creator info
      .withCreatedBy(userId);

    // call createLink helper
    return this.createLink(linkBuilder);
  }

  /**
   * Appends a new Link to a Trace.
   *
   * @param input  the appendLink input argument
   * @returns the new Link
   */
  public async appendLink<TLinkData>(input: AppendLinkInput<TLinkData>) {
    // retrieve parent link
    const parentLink = await this.getHeadLink(input);

    // extract info from input
    const { data, formId } = input;

    // extract info from config
    const { workflowId, userId, ownerId, groupId } = await this.getConfig();

    // use a TraceLinkBuilder to create the next link
    const linkBuilder = new TraceLinkBuilder<TLinkData>({
      // provide workflow id
      workflowId,
      // and parent link to append to the existing trace
      parentLink
    })
      // this is an attestation
      .forAttestation(formId, data)
      // add owner info
      .withOwner(ownerId)
      // add group info
      .withGroup(groupId)
      // add creator info
      .withCreatedBy(userId);

    // call createLink helper
    return this.createLink(linkBuilder);
  }

  /**
   * Push a trace to a recipient group.
   *
   * @param input the pushTrace input argument
   * @returns the new Link
   */
  public async pushTrace<TLinkData>(input: PushTransferInput<TLinkData>) {
    // retrieve parent link
    const parentLink = await this.getHeadLink(input);

    // extract info from input
    const { data, recipient } = input;

    // extract info from config
    const { workflowId, userId } = await this.getConfig();

    // use a TraceLinkBuilder to create the next link
    const linkBuilder = new TraceLinkBuilder<TLinkData>({
      // provide workflow id
      workflowId,
      // and parent link to append to the existing trace
      parentLink
    })
      // this is a push transfer
      .forPushTransfer(recipient, data)
      // add creator info
      .withCreatedBy(userId);

    // call createLink helper
    return this.createLink(linkBuilder);
  }

  /**
   * Pull a trace from a group.
   *
   * @param input the pullTrace input argument
   * @returns the new Link
   */
  public async pullTrace<TLinkData>(input: PullTransferInput<TLinkData>) {
    // retrieve parent link
    const parentLink = await this.getHeadLink(input);
    // extract info from input
    const { data } = input;

    // extract info from config
    const { workflowId, userId, groupId } = await this.getConfig();

    // use a TraceLinkBuilder to create the next link
    const linkBuilder = new TraceLinkBuilder<TLinkData>({
      // provide workflow id
      workflowId,
      // and parent link to append to the existing trace
      parentLink
    })
      // this is a pull transfer
      .forPullTransfer(groupId, data)
      // add creator info
      .withCreatedBy(userId);

    // call createLink helper
    return this.createLink(linkBuilder);
  }

  /**
   * Accept a transfer of ownership
   *
   * @param input the acceptTransfer input argument
   * @returns the new Link
   */
  public async acceptTransfer<TLinkData>(
    input: TransferResponseInput<TLinkData>
  ) {
    // retrieve parent link
    const parentLink = await this.getHeadLink(input);
    // extract info from input
    const { data } = input;

    // extract info from config
    const { workflowId, userId, ownerId, groupId } = await this.getConfig();

    // use a TraceLinkBuilder to create the next link
    const linkBuilder = new TraceLinkBuilder<TLinkData>({
      // provide workflow id
      workflowId,
      // and parent link to append to the existing trace
      parentLink
    })
      // this is to accept the transfer
      .forAcceptTransfer(data)
      // add owner info
      .withOwner(ownerId)
      // add group info
      .withGroup(groupId)
      // add creator info
      .withCreatedBy(userId);

    // call createLink helper
    return this.createLink(linkBuilder);
  }

  /**
   * Reject a transfer of ownership
   *
   * @param input the rejectTransfer input argument
   * @returns the new Link
   */
  public async rejectTransfer<TLinkData>(
    input: TransferResponseInput<TLinkData>
  ) {
    // retrieve parent link
    const parentLink = await this.getHeadLink(input);

    // extract info from input
    const { data } = input;

    // extract info from config
    const { workflowId, userId } = await this.getConfig();

    // use a TraceLinkBuilder to create the next link
    const linkBuilder = new TraceLinkBuilder<TLinkData>({
      // provide workflow id
      workflowId,
      // and parent link to append to the existing trace
      parentLink
    })
      // this is to reject the transfer
      .forRejectTransfer(data)
      // add creator info
      .withCreatedBy(userId);

    // call createLink helper
    return this.createLink(linkBuilder);
  }

  /**
   * Cancel a transfer of ownership
   *
   * @param input the cancelTransfer input argument
   * @returns the new Link
   */
  public async cancelTransfer<TLinkData>(
    input: TransferResponseInput<TLinkData>
  ) {
    // retrieve parent link
    const parentLink = await this.getHeadLink(input);

    // extract info from input
    const { data } = input;

    // extract info from config
    const { workflowId, userId } = await this.getConfig();

    // use a TraceLinkBuilder to create the next link
    const linkBuilder = new TraceLinkBuilder<TLinkData>({
      // provide workflow id
      workflowId,
      // and parent link to append to the existing trace
      parentLink
    })
      // this is to cancel the transfer
      .forCancelTransfer(data)
      // add creator info
      .withCreatedBy(userId);

    // call createLink helper
    return this.createLink(linkBuilder);
  }

  /**
   * Get the state of a given trace.
   *
   * @param input the getTraceState input
   * @return the state of the trace
   */
  public async getTraceState(input: GetTraceStateInput) {
    // extract info from input
    const { traceId } = input;

    // shortcut types
    type Response = GetTraceStateQuery.Response;
    type Variables = GetTraceStateQuery.Variables;

    // execute graphql query
    const rsp = await this.client.graphql<Response, Variables>(
      GetTraceStateQuery.document,
      { traceId }
    );

    // build and return the TraceState object
    return this.makeTraceState(rsp.trace);
  }

  /**
   * Get the details of a given trace.
   *
   * @param input the getTraceDetails input
   * @return the trace details
   */
  public async getTraceDetails(input: GetTraceDetailsInput) {
    // shortcut types
    type Response = GetTraceDetailsQuery.Response;
    type Variables = GetTraceDetailsQuery.Variables;

    // execute graphql query
    const rsp = await this.client.graphql<Response, Variables>(
      GetTraceDetailsQuery.document,
      input
    );

    // construct the link objects from raw responses
    const links = rsp.trace.links.nodes.map(l => fromObject(l.raw));

    // get pagination related info from response
    const { info, totalCount } = rsp.trace.links;

    // the details response object
    const details: TraceDetails = {
      links,
      totalCount,
      info
    };

    // return details result
    return details;
  }

  /**
   * Get the incoming traces.
   *
   * @param paginationInfo the pagination info
   * @return the incoming traces
   */
  public async getIncomingTraces(paginationInfo: PaginationInfo) {
    return this.getTracesInStage('INCOMING', paginationInfo);
  }

  /**
   * Get the outgoing traces.
   *
   * @param paginationInfo the pagination info
   * @return the outgoing traces
   */
  public async getOutgoingTraces(paginationInfo: PaginationInfo) {
    return this.getTracesInStage('OUTGOING', paginationInfo);
  }

  /**
   * Get the backlog traces.
   *
   * @param paginationInfo the pagination info
   * @return the backlog traces
   */
  public async getBacklogTraces(paginationInfo: PaginationInfo) {
    return this.getTracesInStage('BACKLOG', paginationInfo);
  }
}