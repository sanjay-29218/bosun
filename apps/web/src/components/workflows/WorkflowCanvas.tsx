import "@xyflow/react/dist/style.css";

import type { WorkflowDefinition } from "@t3tools/contracts";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Handle,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnDelete,
  type OnNodeDrag,
} from "@xyflow/react";
import { Maximize2Icon, PlusIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react";
import { createContext, use, useCallback, useMemo, useState, type CSSProperties } from "react";

import { cn } from "../../lib/utils";
import { SettingsGroup } from "../settings/SettingsGroup";
import { canRemoveStage, humanizeWorkflowId, removeStage } from "../settings/WorkflowEditor.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Group } from "../ui/group";
import {
  canRemoveRoute,
  connectRoute,
  removeRoute,
  withNodePositions,
  workflowCanvasStepIds,
  workflowNodePositions,
  workflowRoutes,
  type CanvasPosition,
} from "./WorkflowCanvas.logic";
import { WorkflowCanvasInspector, type CanvasSelection } from "./WorkflowCanvasInspector";

type StageNodeData = {
  readonly botId: string;
  readonly outcomes: readonly string[];
  readonly first: boolean;
  readonly gate: boolean;
};
type StageNode = Node<StageNodeData, "stage">;
type EndNode = Node<Record<string, never>, "end">;
type CanvasNode = StageNode | EndNode;
type CanvasEdge = Edge;

export interface WorkflowCanvasProps {
  readonly definition: WorkflowDefinition;
  readonly roleName: (botId: string) => string;
  readonly stageName: (stepId: string) => string;
  readonly onChange: (definition: WorkflowDefinition) => void;
  readonly onEditStage: (stepId: string) => void;
  /** Opens the add-stage dialog, placing the new stage after `after` when given. */
  readonly onAddStage: (after: string | undefined) => void;
}

const CanvasLabels = createContext<Pick<WorkflowCanvasProps, "roleName" | "stageName">>({
  roleName: humanizeWorkflowId,
  stageName: humanizeWorkflowId,
});

// React Flow reads these in place of its own palette, so the canvas follows the app theme.
const CANVAS_THEME = {
  "--xy-background-color": "transparent",
  "--xy-background-pattern-dots-color": "var(--color-border)",
  "--xy-edge-stroke": "var(--color-muted-foreground)",
  "--xy-edge-stroke-selected": "var(--color-foreground)",
  "--xy-edge-label-background-color": "var(--color-background)",
  "--xy-edge-label-color": "var(--color-muted-foreground)",
  "--xy-connectionline-stroke": "var(--color-muted-foreground)",
  "--xy-handle-background-color": "var(--color-muted-foreground)",
  "--xy-handle-border-color": "var(--color-card)",
  "--xy-selection-background-color": "color-mix(in srgb, var(--color-ring) 8%, transparent)",
  "--xy-selection-border": "1px solid var(--color-ring)",
  "--xy-attribution-background-color": "transparent",
} as CSSProperties;

const NODE_TYPES = { stage: StageNodeView, end: EndNodeView };
const DELETE_KEYS = ["Backspace", "Delete"];
const FIT_VIEW_OPTIONS = { maxZoom: 1, padding: 0.2 };
const NODE_CLASS = "rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Builds React Flow nodes from the definition. Selection and measured sizes
 * carry over from `previous`, so an edit keeps what the inspector shows and
 * React Flow only re-measures a stage whose outcome handles changed.
 */
function canvasNodes(definition: WorkflowDefinition, previous: readonly CanvasNode[]) {
  const positions = workflowNodePositions(definition);
  const before = new Map(previous.map((node) => [node.id, node]));
  return workflowCanvasStepIds(definition).flatMap((id): CanvasNode[] => {
    const step = definition.steps[id];
    const position = positions[id];
    if (!step || !position) return [];
    const old = before.get(id);
    const outcomes = step.type === "task" ? Object.keys(step.next) : [];
    const sameHandles =
      old !== undefined &&
      (old.type === "stage" ? old.data.outcomes.join() : "") === outcomes.join() &&
      (old.type === "end") === (step.type === "end");
    const kept = {
      ...(old?.measured && sameHandles ? { measured: old.measured } : {}),
      ...(old?.selected ? { selected: true } : {}),
    };
    if (step.type === "end") {
      return [
        { id, type: "end", position, data: {}, deletable: false, className: NODE_CLASS, ...kept },
      ];
    }
    return [
      {
        id,
        type: "stage",
        position,
        deletable: canRemoveStage(definition, id),
        className: NODE_CLASS,
        data: {
          botId: step.bot,
          outcomes,
          first: definition.start === id,
          gate: step.gate === true,
        },
        ...kept,
      },
    ];
  });
}

function canvasEdges(definition: WorkflowDefinition, previous: readonly CanvasEdge[]) {
  const selected = new Set(previous.filter((edge) => edge.selected).map((edge) => edge.id));
  return workflowRoutes(definition).map((route): CanvasEdge => ({
    id: route.id,
    source: route.stepId,
    sourceHandle: route.outcome,
    target: route.target,
    deletable: canRemoveRoute(definition, route.stepId),
    ...(route.limit !== null ? { label: `up to ${route.limit}×` } : {}),
    ...(selected.has(route.id) ? { selected: true } : {}),
  }));
}

function canvasSelection(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[]) {
  const node = nodes.find((candidate) => candidate.selected);
  if (node) return { kind: node.type === "end" ? "end" : "stage", stepId: node.id } as const;
  const edge = edges.find((candidate) => candidate.selected);
  return edge?.sourceHandle
    ? ({ kind: "route", stepId: edge.source, outcome: edge.sourceHandle } as const)
    : null;
}

/** Stages and routes on a pannable canvas, with an inspector for whatever is selected. */
export default function WorkflowCanvas({
  definition,
  roleName,
  stageName,
  onChange,
  onEditStage,
  onAddStage,
}: WorkflowCanvasProps) {
  const [graph, setGraph] = useState(() => ({
    definition,
    nodes: canvasNodes(definition, []),
    edges: canvasEdges(definition, []),
  }));
  if (graph.definition !== definition) {
    setGraph({
      definition,
      nodes: canvasNodes(definition, graph.nodes),
      edges: canvasEdges(definition, graph.edges),
    });
  }
  const labels = useMemo(() => ({ roleName, stageName }), [roleName, stageName]);
  const selection: CanvasSelection | null = canvasSelection(graph.nodes, graph.edges);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) =>
      setGraph((current) => ({ ...current, nodes: applyNodeChanges(changes, current.nodes) })),
    [],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<CanvasEdge>[]) =>
      setGraph((current) => ({ ...current, edges: applyEdgeChanges(changes, current.edges) })),
    [],
  );
  const onConnect = (connection: Connection) => {
    if (connection.sourceHandle) {
      onChange(
        connectRoute(definition, connection.source, connection.sourceHandle, connection.target),
      );
    }
  };
  const onNodeDragStop: OnNodeDrag<CanvasNode> = (_event, _node, dragged) => {
    // Saving every node's position keeps the drawing stable as stages come and go.
    const positions: Record<string, CanvasPosition> = {};
    for (const node of [...graph.nodes, ...dragged]) positions[node.id] = node.position;
    onChange(withNodePositions(definition, positions));
  };
  const onDelete: OnDelete<CanvasNode, CanvasEdge> = ({ nodes, edges }) => {
    const removed = new Set(nodes.map((node) => node.id));
    let next = definition;
    for (const id of removed) next = removeStage(next, id);
    for (const edge of edges) {
      if (!removed.has(edge.source) && edge.sourceHandle) {
        next = removeRoute(next, edge.source, edge.sourceHandle);
      }
    }
    onChange(next);
  };

  return (
    <CanvasLabels value={labels}>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <SettingsGroup className="h-[32rem] overflow-hidden">
          <ReactFlow<CanvasNode, CanvasEdge>
            aria-label={`${definition.name} stages and routes`}
            nodes={graph.nodes}
            edges={graph.edges}
            nodeTypes={NODE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={(connection) => connection.source !== connection.target}
            onNodeDragStop={onNodeDragStop}
            onDelete={onDelete}
            deleteKeyCode={DELETE_KEYS}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            minZoom={0.25}
            maxZoom={1.5}
            // The page scrolls; inside the canvas the wheel pans and a pinch zooms.
            panOnScroll
            zoomOnScroll={false}
            style={CANVAS_THEME}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <Panel position="top-right">
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  onAddStage(selection?.kind === "stage" ? selection.stepId : undefined)
                }
              >
                <PlusIcon />
                {selection?.kind === "stage"
                  ? `Add stage after ${stageName(selection.stepId)}`
                  : "Add stage"}
              </Button>
            </Panel>
            <CanvasZoomControls />
          </ReactFlow>
        </SettingsGroup>
        <WorkflowCanvasInspector
          definition={definition}
          selection={selection}
          roleName={roleName}
          stageName={stageName}
          onChange={onChange}
          onEditStage={onEditStage}
        />
      </div>
    </CanvasLabels>
  );
}

function CanvasZoomControls() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  return (
    <Panel position="bottom-left">
      <Group orientation="vertical">
        <Button size="icon-xs" variant="outline" aria-label="Zoom in" onClick={() => void zoomIn()}>
          <ZoomInIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="outline"
          aria-label="Zoom out"
          onClick={() => void zoomOut()}
        >
          <ZoomOutIcon />
        </Button>
        <Button
          size="icon-xs"
          variant="outline"
          aria-label="Fit workflow"
          onClick={() => void fitView(FIT_VIEW_OPTIONS)}
        >
          <Maximize2Icon />
        </Button>
      </Group>
    </Panel>
  );
}

function StageNodeView({ id, data, selected }: NodeProps<StageNode>) {
  const { roleName, stageName } = use(CanvasLabels);
  return (
    <div
      className={cn(
        "w-56 rounded-lg border bg-card text-card-foreground shadow-xs/5",
        selected ? "border-ring" : "border-border",
      )}
    >
      <Handle type="target" position={Position.Left} />
      <div className="space-y-0.5 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{stageName(id)}</span>
          {data.first ? <Badge variant="outline">First</Badge> : null}
          {data.gate ? <Badge variant="info">Approval</Badge> : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">{roleName(data.botId)}</div>
      </div>
      <div className="border-t border-border/50 py-1">
        {data.outcomes.map((outcome) => (
          <div
            key={outcome}
            className="relative px-3 py-0.5 text-right text-xs text-muted-foreground"
          >
            {humanizeWorkflowId(outcome)}
            <Handle type="source" position={Position.Right} id={outcome} />
          </div>
        ))}
      </div>
    </div>
  );
}

function EndNodeView({ id, selected }: NodeProps<EndNode>) {
  const { stageName } = use(CanvasLabels);
  return (
    <div
      className={cn(
        "rounded-lg border bg-card px-3 py-2 text-sm font-medium text-card-foreground shadow-xs/5",
        selected ? "border-ring" : "border-border",
      )}
    >
      <Handle type="target" position={Position.Left} />
      {stageName(id)}
    </div>
  );
}
