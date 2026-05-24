import type { Json } from "../json.js";
import type { McpToolCall } from "../mcp.js";

export type WrapperArgumentReader = "stringified-json" | "plain-object";

export type WrapperFamilyDescriptor = {
  family: string;
  matchesToolName(toolName: string): boolean;
  argumentReader: WrapperArgumentReader;
  operationFieldPaths: readonly (readonly string[])[];
  composeActionType(operationValues: readonly string[]): string;
};

const ZAPIER_WRAPPER_TOOL_NAME = /^(?:mcp_zapier_)?execute_zapier_[a-z0-9_]+_action$/;

export const WRAPPER_FAMILY_DESCRIPTORS: readonly WrapperFamilyDescriptor[] = [
  {
    family: "zapier",
    matchesToolName: (toolName) => ZAPIER_WRAPPER_TOOL_NAME.test(toolName),
    argumentReader: "stringified-json",
    operationFieldPaths: [["app"], ["action"]],
    composeActionType: ([app, action]) =>
      `zapier.${normalizeActionPart(app)}.${normalizeActionPart(action)}`
  },
  {
    family: "apify",
    matchesToolName: (toolName) => toolName === "call-actor",
    argumentReader: "plain-object",
    operationFieldPaths: [["actor"]],
    composeActionType: ([actor]) => `apify.${normalizeActionPart(actor)}`
  }
];

export function resolveWrapperFamilyActionType(
  call: McpToolCall,
  descriptors: readonly WrapperFamilyDescriptor[] = WRAPPER_FAMILY_DESCRIPTORS
): string {
  const descriptor = descriptors.find((candidate) => candidate.matchesToolName(call.toolName));

  if (!descriptor) {
    return call.toolName;
  }

  const declaredArguments = readDeclaredArguments(call.arguments, descriptor.argumentReader);

  if (!declaredArguments) {
    return call.toolName;
  }

  const operationValues = readOperationValues(
    declaredArguments,
    descriptor.operationFieldPaths
  );

  if (!operationValues) {
    return call.toolName;
  }

  return descriptor.composeActionType(operationValues);
}

function readDeclaredArguments(
  rawArguments: Json,
  reader: WrapperArgumentReader
): Record<string, unknown> | undefined {
  if (reader === "plain-object") {
    return isRecord(rawArguments) ? rawArguments : undefined;
  }

  if (typeof rawArguments !== "string") {
    return undefined;
  }

  try {
    const parsed = JSON.parse(rawArguments) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readOperationValues(
  declaredArguments: Record<string, unknown>,
  fieldPaths: readonly (readonly string[])[]
): readonly string[] | undefined {
  const values = fieldPaths.map((fieldPath) => readStringField(declaredArguments, fieldPath));

  if (values.some((value) => value === undefined)) {
    return undefined;
  }

  return values as string[];
}

function readStringField(
  declaredArguments: Record<string, unknown>,
  fieldPath: readonly string[]
): string | undefined {
  let value: unknown = declaredArguments;

  for (const segment of fieldPath) {
    if (!isRecord(value)) {
      return undefined;
    }
    value = value[segment];
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return value;
}

function normalizeActionPart(value: string): string {
  return value.trim().toLowerCase().replace(/[\/\s]+/g, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
