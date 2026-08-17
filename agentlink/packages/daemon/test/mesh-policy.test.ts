import { describe, expect, test } from "bun:test";
import {
  b64encode,
  generateMeshSigningKeyPair,
  signMeshCapabilityGrant,
  signMeshApproval,
  verifyMeshApproval,
  verifyMeshCapabilityGrant,
  type MeshApproval,
  type MeshCapabilityGrant,
  type MeshResource,
  type MeshTaskRequest,
} from "@agentlink/wire";
import { MeshPolicyEngine } from "../src/mesh/policy";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");
const SIGNER = generateMeshSigningKeyPair();
const GROUP_ID = "group-alpha";

const resource: MeshResource = {
  id: "repo:node-b-project",
  ownerNodeId: "node-b",
  kind: "repo",
  displayName: "node-b project",
  rootHint: "workspace/project",
};

const request = (operation: MeshTaskRequest["operation"]): MeshTaskRequest => ({
  groupId: GROUP_ID,
  taskId: `task-${operation}`,
  requesterNodeId: "node-a",
  targetNodeId: "node-b",
  resourceId: resource.id,
  operation,
  scope: operation === "run" ? { argv: ["bun", "test"], network: false } : undefined,
});

function grantFor(task: MeshTaskRequest, overrides: Partial<MeshCapabilityGrant> = {}): MeshCapabilityGrant {
  const unsigned = {
    groupId: task.groupId,
    taskId: task.taskId,
    grantId: "grant-1",
    subjectNodeId: task.requesterNodeId,
    targetNodeId: task.targetNodeId,
    resourceId: task.resourceId,
    operation: task.operation,
    scope: task.scope ?? {},
    issuedAt: "2026-08-17T11:59:00.000Z",
    expiresAt: "2026-08-17T13:00:00.000Z",
    nonce: `nonce-${task.operation}`,
    issuerNodeId: resource.ownerNodeId,
    issuerPublicKey: b64encode(SIGNER.publicKey),
    ...overrides,
  };
  return signMeshCapabilityGrant(unsigned, SIGNER.secretKey);
}

function approvalFor(grant: MeshCapabilityGrant, overrides: Partial<MeshApproval> = {}): MeshApproval {
  const { signature: _ignoredSignature, ...safeOverrides } = overrides;
  const unsigned: Omit<MeshApproval, "signature"> = {
    approvalId: "approval-1",
    grantId: grant.grantId,
    approverNodeId: resource.ownerNodeId,
    approverPublicKey: b64encode(SIGNER.publicKey),
    decision: "allow",
    summary: "owner approved the exact resource and operation",
    createdAt: "2026-08-17T12:00:00.000Z",
    ...safeOverrides,
  };
  return signMeshApproval(unsigned, SIGNER.secretKey);
}

function engine(audit: unknown[] = []): MeshPolicyEngine {
  return new MeshPolicyEngine({
    nodeId: "node-b",
    trustedRequesters: new Set(["node-a"]),
    trustedGroups: new Set([GROUP_ID]),
    clock: () => NOW,
    verifyGrant: (grant) => grant.issuerPublicKey === b64encode(SIGNER.publicKey)
      && verifyMeshCapabilityGrant(grant, SIGNER.publicKey),
    verifyApproval: (approval) => approval.approverPublicKey === b64encode(SIGNER.publicKey)
      && verifyMeshApproval(approval, SIGNER.publicKey),
    auditSink: (event) => { audit.push(event); },
  });
}

describe("MeshPolicyEngine", () => {
  test("A cannot delete B's resource even with a valid-looking grant and approval", () => {
    const policy = engine();
    const task = request("delete");
    const grant = grantFor(task);
    const result = policy.authorize(task, { resource, grant, approval: approvalFor(grant), nowMs: NOW });
    expect(result).toMatchObject({ decision: "deny", allowed: false, risk: "critical", reason: "operation-denied" });
  });

  test("inspect is read-only and still requires a trusted requester when configured", () => {
    const policy = engine();
    expect(policy.authorize(request("inspect"), { resource, nowMs: NOW }).decision).toBe("allow");
    const untrusted = policy.authorize({ ...request("inspect"), requesterNodeId: "node-evil" }, { resource, nowMs: NOW });
    expect(untrusted).toMatchObject({ decision: "deny", reason: "requester-not-trusted" });
  });

  test("group membership is explicit when a group member map is configured", () => {
    const policy = new MeshPolicyEngine({
      nodeId: "node-b",
      trustedGroups: new Set([GROUP_ID]),
      groupMembers: new Map([
        [GROUP_ID, new Set(["node-b", "node-c"])],
      ]),
      trustedRequesters: new Set(["node-c"]),
      clock: () => NOW,
      auditSink: () => {},
    });
    const result = policy.authorize({ ...request("inspect"), requesterNodeId: "node-a" }, { resource, nowMs: NOW });
    expect(result).toMatchObject({ decision: "deny", reason: "group-member-not-trusted" });
  });

  test("a mutating allow is denied when no audit sink is available", () => {
    const policy = new MeshPolicyEngine({
      nodeId: "node-b",
      trustedGroups: new Set([GROUP_ID]),
      trustedRequesters: new Set(["node-a"]),
      clock: () => NOW,
      verifyGrant: (grant) => verifyMeshCapabilityGrant(grant, SIGNER.publicKey),
    });
    const task = request("stage");
    const result = policy.authorize(task, { resource, grant: grantFor(task), nowMs: NOW });
    expect(result).toMatchObject({ decision: "deny", reason: "audit-unavailable" });
  });

  test("stage/run require a matching authenticated grant and consume its nonce once", () => {
    const policy = engine();
    const task = request("run");
    expect(policy.authorize(task, { resource, nowMs: NOW })).toMatchObject({ decision: "deny", reason: "grant-required" });
    const grant = grantFor(task);
    const allowed = policy.authorize(task, { resource, grant, nowMs: NOW });
    expect(allowed).toMatchObject({ decision: "allow", allowed: true, risk: "medium" });
    expect(policy.authorize(task, { resource, grant, nowMs: NOW })).toMatchObject({ decision: "deny", reason: "grant-replay" });
  });

  test("quarantine pauses for owner approval and then allows the exact grant", () => {
    const policy = engine();
    const task = request("quarantine");
    const grant = grantFor(task);
    expect(policy.authorize(task, { resource, grant, nowMs: NOW })).toMatchObject({
      decision: "approval-required",
      allowed: false,
    });
    expect(policy.authorize(task, { resource, grant, approval: approvalFor(grant), nowMs: NOW })).toMatchObject({
      decision: "allow",
      allowed: true,
    });
  });

  test("rejects expired, future, mismatched, revoked and unauthenticated grants", () => {
    const policy = engine();
    const task = request("stage");
    const expired = grantFor(task, {
      expiresAt: "2026-08-17T11:59:30.000Z",
      nonce: "nonce-expired",
    });
    expect(policy.authorize(task, { resource, grant: expired, nowMs: NOW })).toMatchObject({ decision: "deny", reason: "grant-expired" });

    const future = grantFor(task, {
      issuedAt: "2026-08-17T12:10:00.000Z",
      nonce: "nonce-future",
    });
    expect(policy.authorize(task, { resource, grant: future, nowMs: NOW })).toMatchObject({ decision: "deny", reason: "grant-issued-in-future" });

    const wrongTarget = grantFor(task, { targetNodeId: "node-evil", nonce: "nonce-target" });
    expect(policy.authorize(task, { resource, grant: wrongTarget, nowMs: NOW })).toMatchObject({ decision: "deny", reason: "grant-target-mismatch" });

    const revoked = grantFor(task, { nonce: "nonce-revoked" });
    policy.revokeGrant(revoked.grantId);
    expect(policy.authorize(task, { resource, grant: revoked, nowMs: NOW })).toMatchObject({ decision: "deny", reason: "grant-revoked" });

    const forged = { ...grantFor(task, { nonce: "nonce-forged" }), signature: "not-a-valid-signature" };
    expect(policy.authorize(task, { resource, grant: forged, nowMs: NOW })).toMatchObject({
      decision: "deny",
      reason: "grant-authentication-failed",
    });
  });

  test("approval must come from B and audit output contains no grant signature", () => {
    const audit: unknown[] = [];
    const policy = engine(audit);
    const task = request("apply-patch");
    const grant = grantFor(task);
    const wrongOwner = approvalFor(grant, { approverNodeId: "node-a" });
    expect(policy.authorize(task, { resource, grant, approval: wrongOwner, nowMs: NOW })).toMatchObject({
      decision: "deny",
      reason: "approval-owner-mismatch",
    });
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain(grant.signature);
  });
});
