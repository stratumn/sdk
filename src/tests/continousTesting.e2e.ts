/**
 * @jest-environment jsdom
 */
import uuid from 'uuid/v4';
import { Sdk } from '../sdk';
import { fixtures } from '../fixtures';

const getEnvVariable = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Env variable ${key} has not been set.`);
  }
  return value;
};

const [
  traceApiUrl,
  accountApiUrl,
  mediaApiUrl,
  workflowId,
  bot1Key,
  teamBId,
  bot2Email,
  bot2Password,
  formRequestId,
  formResponseId
] = [
  'TRACE_API_URL',
  'ACCOUNT_API_URL',
  'MEDIA_API_URL',
  'WORKFLOW_ID',
  'BOT_1_KEY',
  'TEAM_B_ID',
  'BOT_2_EMAIL',
  'BOT_2_PASSWORD',
  'FORM_REQUEST_ID',
  'FORM_RESPONSE_ID'
].map(getEnvVariable);

const endpoints = {
  account: accountApiUrl,
  media: mediaApiUrl,
  trace: traceApiUrl
};

it('continuous testing', async () => {
  const sdkBot1 = new Sdk({
    workflowId,
    endpoints,
    secret: { privateKey: bot1Key }
  });
  const sdkBot2 = new Sdk({
    workflowId,
    endpoints,
    secret: { email: bot2Email, password: bot2Password }
  });

  const numRequests = 3;
  const requestsBody = Array.from(Array(numRequests)).map(
    () => `request id: ${uuid()}`
  );
  const requests = await Promise.all(
    requestsBody.map(body =>
      sdkBot1.newTrace({
        formId: formRequestId,
        data: {
          body
        }
      })
    )
  );

  expect(requests).toHaveLength(numRequests);

  const [firstRequest, secondRequest, thirdRequest] = requests;

  const firstPush = await sdkBot1.pushTrace({
    traceId: firstRequest.traceId,
    recipient: teamBId
  });

  expect(firstPush.traceId).toBe(firstRequest.traceId);
  expect(firstPush.headLink.prevLinkHash()).toEqual(
    firstRequest.headLink.hash()
  );

  await sdkBot1.pushTrace({
    prevLink: secondRequest.headLink,
    recipient: teamBId
  });

  await sdkBot1.pushTrace({
    prevLink: thirdRequest.headLink,
    recipient: teamBId
  });

  const incoming = await sdkBot2.getIncomingTraces({ first: numRequests });
  expect(incoming.totalCount).toBeGreaterThanOrEqual(numRequests);
  expect(incoming.traces).toHaveLength(numRequests);
  expect(incoming.traces.map(t => t.traceId)).toEqual(
    expect.arrayContaining(requests.map(r => r.traceId))
  );

  await sdkBot2.acceptTransfer({ traceId: firstRequest.traceId });
  const backlog = await sdkBot2.getBacklogTraces({ first: 1 });
  expect(backlog.totalCount).toBeGreaterThanOrEqual(1);
  expect(backlog.traces[0].traceId).toEqual(firstRequest.traceId);

  const { nodeJsFilePath } = fixtures.FileWrappers;
  const secondResponse = await sdkBot2.appendLink({
    formId: formResponseId,
    traceId: secondRequest.traceId,
    data: {
      status: '200',
      body: 'OK. Files attached.',
      attachments: [nodeJsFilePath]
    }
  });
  const { attachments } = secondResponse.headLink.formData();
  expect(attachments).toHaveLength(1);
  expect(attachments).toEqual([
    {
      digest: expect.any(String),
      mimetype: 'image/png',
      name: 'stratumn.png',
      size: expect.any(Number)
    }
  ]);
}, 30000); // set custom timeout of 30 seconds as this test can take a long time to run
