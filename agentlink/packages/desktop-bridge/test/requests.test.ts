import { expect, test } from "bun:test";
import { approvalTarget, pendingRequests } from "../src/requests";
import { publicState } from "../src/state";

const command = "/bin/zsh -lc 'brctl download /Users/test/Documents/transfer /Users/test/Documents/transfer.tar.gz /Users/test/Documents/transfer.tar.gz.sha256'";
const request = { method: "item/commandExecution/requestApproval", id: 4, params: { reason: "允许下载已确认的历史迁移文件？不会删除云端文件。", command, cwd: "/Users/test/project", availableDecisions: ["accept", "cancel"] } };

test("approval explanation, exact command and directory survive normalization together", () => {
  const state = { requests: [request], externalRequests: [{request}], turns: [] };
  const view = publicState(state);
  expect(view.requests).toHaveLength(1);
  expect(view.requests[0]).toMatchObject({ id: 4, method: request.method, reason: request.params.reason, command, cwd: request.params.cwd });
  expect(view.requests[0].actions.map((action: any) => action.value)).toEqual(["accept", "cancel"]);
  view.requests[0].details.availableDecisions.push("decline");
  expect(request.params.availableDecisions).toEqual(["accept", "cancel"]);
});

test("external approvals route by both method and native ID and reject stale or unoffered choices", () => {
  const file = { requestId: "file-id", request: { method: "item/fileChange/requestApproval", params: { reason: "修改文件" } } };
  const state = { requests: [], externalRequests: [file, request] };
  expect(pendingRequests(state)).toHaveLength(2);
  expect(approvalTarget(state, "file-id", "item/fileChange/requestApproval", "accept")).toMatchObject({kind:"file",request:{id:"file-id"}});
  expect(approvalTarget(state, 4, request.method, "cancel")).toMatchObject({kind:"command",request:{id:4}});
  expect(() => approvalTarget(state, 4, request.method, "decline")).toThrow("不支持");
  expect(() => approvalTarget(state, 4, "item/fileChange/requestApproval", "accept")).toThrow("已结束");
  expect(() => approvalTarget({requests:[]}, 4, request.method, "accept")).toThrow("已结束");
});

test("a command rule decision must exactly match the native offered amendment", () => {
  const decision = {acceptWithExecpolicyAmendment:{execpolicy_amendment:["brctl","download"]}};
  const state = {requests:[{...request,params:{...request.params,availableDecisions:["accept",decision,"cancel"]}}]};
  expect(approvalTarget(state, 4, request.method, decision).request.id).toBe(4);
  expect(() => approvalTarget(state, 4, request.method, {acceptWithExecpolicyAmendment:{execpolicy_amendment:["sh"]}})).toThrow("不支持");
});

test("current restricted turn stays distinct from next-turn Full Access", () => {
  const view = publicState({currentPermissions:{approvalPolicy:"on-request",approvalsReviewer:"auto_review",sandboxPolicy:{type:"workspaceWrite"}},latestThreadSettings:{approvalPolicy:"never",approvalsReviewer:"user",activePermissionProfile:{id:":danger-full-access"}}});
  expect(view.currentPermissions).toMatchObject({fullAccess:false,approvalsReviewer:"auto_review",sandbox:"workspaceWrite"});
  expect(view.nextPermissions).toMatchObject({fullAccess:true,approvalsReviewer:"user",profile:":danger-full-access"});
});
