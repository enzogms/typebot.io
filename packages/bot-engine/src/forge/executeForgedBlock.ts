import { BubbleBlockType } from "@typebot.io/blocks-bubbles/constants";
import type { Block } from "@typebot.io/blocks-core/schemas/schema";
import type {
  SessionState,
  TypebotInSession,
} from "@typebot.io/chat-session/schemas";
import { decrypt } from "@typebot.io/credentials/decrypt";
import { getCredentials } from "@typebot.io/credentials/getCredentials";
import { forgedBlocks } from "@typebot.io/forge-repository/definitions";
import type { ForgedBlock } from "@typebot.io/forge-repository/schemas";
import type { LogsStore, VariableStore } from "@typebot.io/forge/types";
import { byId, isDefined } from "@typebot.io/lib/utils";
import type { SessionStore } from "@typebot.io/runtime-session-store";
import { deepParseVariables } from "@typebot.io/variables/deepParseVariables";
import {
  type ParseVariablesOptions,
  parseVariables,
} from "@typebot.io/variables/parseVariables";
import type { SetVariableHistoryItem } from "@typebot.io/variables/schemas";
import type { ContinueChatResponse } from "../schemas/api";
import type { ExecuteIntegrationResponse } from "../types";
import { updateVariablesInSession } from "../updateVariablesInSession";

export const executeForgedBlock = async (
  block: ForgedBlock,
  { state, sessionStore }: { state: SessionState; sessionStore: SessionStore },
): Promise<ExecuteIntegrationResponse> => {
  const blockDef = forgedBlocks[block.type];
  if (!blockDef) return { outgoingEdgeId: block.outgoingEdgeId };
  const action = blockDef.actions.find((a) => a.name === block.options?.action);
  if (!block.options || !action)
    return {
      outgoingEdgeId: block.outgoingEdgeId,
      logs: [
        {
          description: `${block.type} is not configured`,
        },
      ],
    };
  const noCredentialsError = {
    status: "error",
    description: "Credentials not provided for integration",
  };

  let credentials: { data: string; iv: string } | null = null;
  if (blockDef.auth) {
    if (!block.options.credentialsId) {
      return {
        outgoingEdgeId: block.outgoingEdgeId,
        logs: [noCredentialsError],
      };
    }
    credentials = await getCredentials(
      block.options.credentialsId,
      state.workspaceId,
    );
    if (!credentials) {
      console.error("Could not find credentials in database");
      return {
        outgoingEdgeId: block.outgoingEdgeId,
        logs: [noCredentialsError],
      };
    }
  }

  const typebot = state.typebotsQueue[0].typebot;
  if (
    action?.run?.stream &&
    isNextBubbleTextWithStreamingVar(typebot)(
      block.id,
      action.run.stream.getStreamVariableId(block.options),
    ) &&
    state.isStreamEnabled &&
    !state.whatsApp
  ) {
    return {
      outgoingEdgeId: block.outgoingEdgeId,
      clientSideActions: [
        {
          type: "stream",
          expectsDedicatedReply: true,
          stream: true,
        },
      ],
    };
  }

  let newSessionState = state;
  const setVariableHistory: SetVariableHistoryItem[] = [];

  const variables: VariableStore = {
    get: (id: string) => {
      const variable = newSessionState.typebotsQueue[0].typebot.variables.find(
        (variable) => variable.id === id,
      );
      return variable?.value;
    },
    set: (variables) => {
      const newVariables = variables
        .map((variable) => {
          const existingVariable =
            newSessionState.typebotsQueue[0].typebot.variables.find(
              (v) => variable.id === v.id,
            );
          if (!existingVariable) return;
          return {
            ...existingVariable,
            value: variable.value,
          };
        })
        .filter(isDefined);
      if (!newVariables) return;
      const { newSetVariableHistory, updatedState } = updateVariablesInSession({
        newVariables,
        state: newSessionState,
        currentBlockId: block.id,
      });
      newSessionState = updatedState;
      setVariableHistory.push(...newSetVariableHistory);
    },
    parse: (text: string, params?: ParseVariablesOptions) =>
      parseVariables(text, {
        variables: newSessionState.typebotsQueue[0].typebot.variables,
        sessionStore,
        ...params,
      }),
    list: () => newSessionState.typebotsQueue[0].typebot.variables,
  };
  const logs: NonNullable<ContinueChatResponse["logs"]> = [];
  const logsStore: LogsStore = {
    add: (log) => {
      if (typeof log === "string") {
        logs.push({
          status: "error",
          description: log,
        });
        return;
      }
      logs.push(log);
    },
  };
  const credentialsData = credentials
    ? await decrypt(credentials.data, credentials.iv)
    : undefined;

  const parsedOptions = deepParseVariables(block.options, {
    variables: newSessionState.typebotsQueue[0].typebot.variables,
    sessionStore,
    removeEmptyStrings: true,
  });
  await action?.run?.server?.({
    credentials: credentialsData ?? {},
    options: parsedOptions,
    variables,
    logs: logsStore,
    sessionStore,
  });

  const clientSideActions: ExecuteIntegrationResponse["clientSideActions"] = [];

  if (action?.run?.web?.parseFunction) {
    clientSideActions.push({
      type: "codeToExecute",
      codeToExecute: action?.run?.web?.parseFunction({
        credentials: credentialsData ?? {},
        options: parsedOptions,
        variables,
        logs: logsStore,
      }),
    });
  }

  return {
    newSessionState,
    outgoingEdgeId: block.outgoingEdgeId,
    logs,
    clientSideActions,
    customEmbedBubble: action?.run?.web?.displayEmbedBubble
      ? {
          type: "custom-embed",
          content: {
            url: action.run.web.displayEmbedBubble.parseUrl({
              credentials: credentialsData ?? {},
              options: parsedOptions,
              variables,
              logs: logsStore,
            }),
            initFunction: action.run.web.displayEmbedBubble.parseInitFunction({
              credentials: credentialsData ?? {},
              options: parsedOptions,
              variables,
              logs: logsStore,
            }),
            waitForEventFunction:
              action.run.web.displayEmbedBubble.waitForEvent?.parseFunction?.({
                credentials: credentialsData ?? {},
                options: parsedOptions,
                variables,
                logs: logsStore,
              }),
          },
        }
      : undefined,
    newSetVariableHistory: setVariableHistory,
  };
};

const isNextBubbleTextWithStreamingVar =
  (typebot: TypebotInSession) =>
  (blockId: string, streamVariableId?: string): boolean => {
    const streamVariable = typebot.variables.find(
      (variable) => variable.id === streamVariableId,
    );
    if (!streamVariable) return false;
    const nextBlock = getNextBlock(typebot)(blockId);
    if (!nextBlock) return false;
    return (
      nextBlock.type === BubbleBlockType.TEXT &&
      (nextBlock.content?.richText?.length ?? 0) > 0 &&
      nextBlock.content?.richText?.at(0)?.children.at(0).text ===
        `{{${streamVariable.name}}}`
    );
  };

const getNextBlock =
  (typebot: TypebotInSession) =>
  (blockId: string): Block | undefined => {
    const group = typebot.groups.find((group) =>
      group.blocks.find(byId(blockId)),
    );
    if (!group) return;
    const blockIndex = group.blocks.findIndex(byId(blockId));
    const nextBlockInGroup = group.blocks.at(blockIndex + 1);
    if (nextBlockInGroup) return nextBlockInGroup;
    const outgoingEdgeId = group.blocks.at(blockIndex)?.outgoingEdgeId;
    if (!outgoingEdgeId) return;
    const outgoingEdge = typebot.edges.find(byId(outgoingEdgeId));
    if (!outgoingEdge) return;
    const connectedGroup = typebot.groups.find(byId(outgoingEdge?.to.groupId));
    if (!connectedGroup) return;
    return outgoingEdge.to.blockId
      ? connectedGroup.blocks.find(
          (block) => block.id === outgoingEdge.to.blockId,
        )
      : connectedGroup?.blocks.at(0);
  };
