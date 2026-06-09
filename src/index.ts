export type { Json, JsonObject } from "./json.js";
export type { BindClient, BindOutcome, BindReceipt, BindRequest, BindResponse } from "./bind.js";
export { buildBindRequest } from "./bind.js";
export { createSyntheticDemoBindClient } from "./bind-client/synthetic-demo.js";
export type { SyntheticDemoBindOptions } from "./bind-client/synthetic-demo.js";
export { createReceiptRecorder } from "./receipt-recorder.js";
export type { ReceiptRecorder, ReceiptSource, RecordedReceipt } from "./receipt-recorder.js";
export {
  resolveWrapperFamilyActionType,
  WRAPPER_FAMILY_DESCRIPTORS
} from "./extractors/wrapper-registry.js";
export type {
  WrapperArgumentReader,
  WrapperFamilyDescriptor
} from "./extractors/wrapper-registry.js";
export type { ForwardDecision } from "./enforcement.js";
export { decideForward } from "./enforcement.js";
export type { McpTool, McpToolCall, McpToolResult, UpstreamMcpClient } from "./mcp.js";
export { BindGateError, ScopeGateError, createProxyCore } from "./proxy-core.js";
export type { ProxyCoreOptions, ProxyScopeContext } from "./proxy-core.js";
export {
  assertScopeConstraintStructural,
  buildLoopCloseRequest,
  closeLoopWithRetry,
  createLoopContext,
  deriveGoalHash,
  loadLoopCloseTuning,
  loadLoopContextFromEnv,
  LoopSession,
  LoopStepBoundError,
  mergeLoopConstraint,
  mergeScopeConstraint,
  stripAuthorityTier,
  verifyLoopChain
} from "./loop.js";
export type {
  LoopBindFn,
  LoopChainLink,
  LoopChainVerification,
  LoopCloseConstraint,
  LoopCloseFields,
  LoopCloseResult,
  LoopCloseTuning,
  LoopConstraint,
  LoopContext,
  ScopeConstraint
} from "./loop.js";
export {
  amendScope,
  assertBoundsEnforceable,
  canonicalizeTarget,
  assertScopeCapsuleStructuralOnly,
  assertScopeStructuralClosed,
  assertScopeStructuralContentBlind,
  canonicalScopeJson,
  checkScopeStructural,
  deriveActionClass,
  deriveScopeRef,
  deriveSidecarHash,
  globToRegExp,
  projectScopeCapsuleForExport,
  resolveTargetPlaintext,
  resolveTargets,
  sealScopeCapsule,
  SCOPE_CAPSULE_VERSION
} from "./scope-capsule.js";
export type {
  ScopeBounds,
  ScopeCapsule,
  ScopeCapsuleExport,
  ScopeDecision,
  ScopeDecisionKind,
  ScopePrivacyMode,
  ScopeSidecarProjection,
  ScopeStructuralDescriptor,
  ScopeStructuralProjection,
  SealedScope
} from "./scope-capsule.js";
export {
  createScopeEventRecorder,
  deriveScopeEventHash,
  projectScopeEvent
} from "./scope-event-recorder.js";
export type {
  RecordScopeEventInput,
  ScopeEvent,
  ScopeEventAttempt,
  ScopeEventDecision,
  ScopeEventRecorder,
  ScopeEventSource,
  ScopeEventType
} from "./scope-event-recorder.js";
export {
  assertValidDelta,
  assertValidRuntimeReport,
  deriveTurnRef,
  hashRuntimeError,
  hashRuntimeResult,
  JUDGMENT_LEDGER_VERSION,
  mergeDelta,
  normalizeDelta,
  normalizeProposed,
  normalizeVerdict,
  projectTurn,
  projectTurnProofMode,
  projectTurnVerifiedContext,
  renderJudgmentLedgerMarkdown,
  turnCore,
  validateJudgmentChain
} from "./judgment-ledger.js";
export type {
  JudgmentChainVerification,
  JudgmentDelta,
  JudgmentProposedMove,
  JudgmentRuntimeReport,
  JudgmentTurn,
  JudgmentTurnInput,
  JudgmentVerdict,
  JudgmentVerdictKind,
  JudgmentVerdictSource
} from "./judgment-ledger.js";
export { createJudgmentRecorder } from "./judgment-recorder.js";
export type { JudgmentLedgerRecorder, JudgmentLedgerSource } from "./judgment-recorder.js";
export { reduceJudgmentLedger } from "./judgment-reducer.js";
export type {
  ReduceJudgmentLedgerInput,
  ReducedJudgmentState,
  RefusedStepRef
} from "./judgment-reducer.js";
export {
  buildContinuationCapsule,
  CONTINUATION_CAPSULE_VERSION,
  diffStructural,
  projectContinuationProofMode,
  renderContinuationCardMarkdown
} from "./continuation-capsule.js";
export type {
  BuildContinuationCapsuleInput,
  ContinuationCapsule,
  ScopeAmendmentRecord,
  ScopeEventRef
} from "./continuation-capsule.js";
export {
  connectStreamableHttpUpstream,
  connectStdioUpstream,
  connectUpstream,
  createMcpProxyServer,
  createMcpRequestHandlers,
  serveStreamableHttpProxy,
  serveStdioProxy
} from "./transport/mcp-sdk.js";
export { serveStandingHttpProxy } from "./transport/standing-http.js";
export type { StandingHttpProxy, StandingHttpProxyOptions } from "./transport/standing-http.js";
export { LoopSessionRegistry } from "./session-registry.js";
export type {
  CloseLoopInput,
  OpenLoopInput,
  SessionSummary
} from "./session-registry.js";
export { serveControlChannel, isLoopbackHost } from "./control-channel.js";
export type {
  ControlChannelHandle,
  ControlChannelLogger,
  ControlChannelOptions
} from "./control-channel.js";
export {
  assertContentBlind,
  assertExternalScope,
  assertNoDuplicateKeys,
  buildGraphNode,
  buildLoopProofBundle,
  deriveKeyId,
  deriveLoopSummary,
  pinTrustRoot,
  renderGraphNodeMarkdown,
  renderProofCardMarkdown,
  renderVerifyInstructionsMarkdown,
  serializeReceipts,
  sha256Hex
} from "./loop-proof-bundle.js";
export type {
  AdvisoryVerdict,
  AuthorityContextGraphNode,
  BuildLoopProofBundleInput,
  BuiltLoopProofBundle,
  BundleCapsuleSection,
  ContentDigest,
  LoopProofBundle,
  LoopSummary,
  ProofReceipt,
  TrustRoot
} from "./loop-proof-bundle.js";
export type {
  McpProxyRequestHandlers,
  StreamableHttpUpstream,
  StdioUpstream,
  StdioUpstreamConfig,
  StreamableHttpUpstreamConfig,
  StreamableHttpProxy,
  StreamableHttpProxyOptions,
  UpstreamConfig
} from "./transport/mcp-sdk.js";

export async function main(): Promise<void> {
  process.stdout.write(
    JSON.stringify(
      {
        status: "ready",
        message:
          "Standalone Lyhna MCP proxy core is ready with stdio and Streamable HTTP transport support."
      },
      null,
      2
    ) + "\n"
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
