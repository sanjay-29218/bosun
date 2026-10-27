import "@xyflow/react/dist/style.css";

import type { RoleConfig, WorkflowDefinition } from "@t3tools/contracts";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionLineType,
  Handle,
  Panel,
  Position,
  ReactFlow,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type OnDelete,
  type ReactFlowInstance,
  type ReactFlowState,
} from "@xyflow/react";
import {
  AlignHorizontalDistributeCenterIcon,
  ExpandIcon,
  Maximize2Icon,
  PlusIcon,
  ShrinkIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "../../lib/utils";
import { SettingsGroup } from "../settings/SettingsGroup";
import {
  addStageForRole,
  canRemoveStage,
  humanizeWorkflowId,
  removeStage,
  stageCapableRoles,
} from "../library/WorkflowEditor.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Group } from "../ui/group";
import {
  arrangeWorkflow,
  canRemoveRoute,
  connectRoute,
  planWorkflowRoutes,
  removeRoute,
  routeLabelPoint,
  routePath,
  routePoints,
  withNodePositions,
  workflowCanvasStepIds,
  workflowNodePositions,
  workflowRouteId,
  workflowRoutes,
  type CanvasPosition,
  type RoutePlan,
} from "./WorkflowCanvas.logic";
import {
  WORKFLOW_ROLE_DRAG_TYPE,
  WorkflowCanvasInspector,
  type CanvasSelection,
} from "./WorkflowCanvasInspector";

type StageNodeData = {
  readonly role: string;
  readonly outcomes: readonly string[];
  readonly first: boolean;
  readonly gate: boolean;
};
type StageNode = Node<StageNodeData, "stage">;
type EndNode = Node<Record<string, never>, "end">;
type CanvasNode = StageNode | EndNode;
type RouteEdgeData = RoutePlan & { readonly limit: number | null };
type CanvasEdge = Edge<RouteEdgeData, "route">;

export interface WorkflowCanvasProps {
  readonly definition: WorkflowDefinition;
  readonly roleName: (slot: string) => string;
  readonly stageName: (stepId: string) => string;
  readonly onChange: (definition: WorkflowDefinition) => void;
  readonly onEditStage: (stepId: string) => void;
  /** Opens the add-stage dialog, placing the new stage after `after` when given. */
  readonly onAddStage: (after: string | undefined) => void;
  /** The environment's roles; the stage-capable ones can be dragged onto the canvas. */
  readonly roles: readonly RoleConfig[];
}

const CanvasLabels = createContext<Pick<WorkflowCanvasProps, "roleName" | "stageName">>({
  roleName: humanizeWorkflowId,
  stageName: humanizeWorkflowId,
});

/**
 * The route being pointed at or selected, which is drawn bright while the rest
 * dim, and the ids of the arrowhead markers routes end in.
 */
const CanvasHighlight = createContext<{
  readonly active: string | null;
  readonly hover: (routeId: string | null) => void;
  readonly markers: { readonly forward: string; readonly back: string; readonly active: string };
}>({ active: null, hover: () => {}, markers: { forward: "", back: "", active: "" } });

// Forward routes enter a stage on the left; back routes and loops enter underneath.
const IN_HANDLE = "in";
const BACK_HANDLE = "back";
const BACK_STROKE = "color-mix(in srgb, var(--color-muted-foreground) 65%, transparent)";

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
const EDGE_TYPES = { route: RouteEdgeView };
const DELETE_KEYS = ["Backspace", "Delete"];
const FIT_VIEW_OPTIONS = { maxZoom: 1, padding: 0.2 };
const NODE_CLASS =
  "rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";

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
          role: step.role,
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
  const plans = planWorkflowRoutes(definition);
  return workflowRoutes(definition).flatMap((route): CanvasEdge[] => {
    const plan = plans.get(route.id);
    if (!plan) return [];
    const under = plan.kind === "back" || plan.kind === "loop";
    return [
      {
        id: route.id,
        type: "route",
        source: route.stepId,
        sourceHandle: route.outcome,
        target: route.target,
        targetHandle: under ? BACK_HANDLE : IN_HANDLE,
        deletable: canRemoveRoute(definition, route.stepId),
        data: { ...plan, limit: route.limit },
        ...(selected.has(route.id) ? { selected: true } : {}),
      },
    ];
  });
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
  roles,
}: WorkflowCanvasProps) {
  const stageRoles = stageCapableRoles(roles);
  // Set once React Flow mounts; drops need it to turn screen points into canvas points.
  const flow = useRef<ReactFlowInstance<CanvasNode, CanvasEdge> | null>(null);
  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes(WORKFLOW_ROLE_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  // A role dropped on the canvas becomes a stage there, and its dialog opens for the task.
  const onDrop = (event: DragEvent) => {
    const role = stageRoles.find(
      (candidate) => candidate.id === event.dataTransfer.getData(WORKFLOW_ROLE_DRAG_TYPE),
    );
    if (!role || !flow.current) return;
    event.preventDefault();
    // The new stage keeps where it was dropped, so the others keep where they are drawn too.
    const added = addStageForRole(
      withNodePositions(definition, workflowNodePositions(definition)),
      role,
      flow.current.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
    );
    onChange(added.definition);
    onEditStage(added.stepId);
  };
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
  const labels = { roleName, stageName };
  // Rebuilt only when what is selected changes, so dragging does not re-render the inspector.
  const selected = canvasSelection(graph.nodes, graph.edges);
  const selectedKind = selected?.kind;
  const selectedStep = selected?.stepId;
  const selectedOutcome = selected?.kind === "route" ? selected.outcome : undefined;
  const selection: CanvasSelection | null =
    !selectedKind || !selectedStep
      ? null
      : selectedKind !== "route"
        ? { kind: selectedKind, stepId: selectedStep }
        : selectedOutcome === undefined
          ? null
          : { kind: "route", stepId: selectedStep, outcome: selectedOutcome };

  const [hovered, setHovered] = useState<string | null>(null);
  const markerId = useId().replace(/[^\w-]/g, "");
  const hoveredRoute = hovered !== null && graph.edges.some((edge) => edge.id === hovered);
  const active = hoveredRoute
    ? hovered
    : selection?.kind === "route"
      ? workflowRouteId(selection.stepId, selection.outcome)
      : null;
  const highlight = {
    active,
    hover: setHovered,
    markers: {
      forward: `${markerId}-forward`,
      back: `${markerId}-back`,
      active: `${markerId}-active`,
    },
  };
  const arrange = () => {
    onChange(withNodePositions(definition, arrangeWorkflow(definition)));
    requestAnimationFrame(() => void flow.current?.fitView(FIT_VIEW_OPTIONS));
  };

  const onNodesChange = (changes: NodeChange<CanvasNode>[]) => {
    setGraph((current) => ({ ...current, nodes: applyNodeChanges(changes, current.nodes) }));
    // A drag ending and an arrow-key move both settle with `dragging: false`. Saving
    // every node's position keeps the drawing stable as stages come and go.
    if (changes.some((change) => change.type === "position" && change.dragging === false)) {
      const positions: Record<string, CanvasPosition> = {};
      for (const node of applyNodeChanges(changes, graph.nodes)) positions[node.id] = node.position;
      onChange(withNodePositions(definition, positions));
    }
  };
  const onEdgesChange = (changes: EdgeChange<CanvasEdge>[]) =>
    setGraph((current) => ({ ...current, edges: applyEdgeChanges(changes, current.edges) }));
  const onConnect = (connection: Connection) => {
    if (connection.sourceHandle) {
      onChange(
        connectRoute(definition, connection.source, connection.sourceHandle, connection.target),
      );
    }
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

  // Expanded, the canvas fills the Library's main pane (not the app) until Escape.
  const [expanded, setExpanded] = useState(false);
  // oxlint-disable-next-line t3code/react-effect-budget -- Listens for Escape on the window only while the canvas is expanded.
  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);
  const host = expanded ? document.querySelector<HTMLElement>("[data-workflow-canvas-host]") : null;

  const canvas = (
    <CanvasLabels value={labels}>
      <CanvasHighlight value={highlight}>
        {/* Sized by the pane, not the window, so the inspector stays beside the canvas. */}
        <div className={cn("@container/workflow-canvas", host && "h-full min-h-0")}>
          <div
            className={cn(
              "grid gap-4 @3xl/workflow-canvas:grid-cols-[minmax(0,1fr)_20rem]",
              host && "h-full min-h-0 @3xl/workflow-canvas:grid-rows-1",
            )}
          >
            <SettingsGroup
              className={cn(
                "overflow-hidden",
                host ? "h-full min-h-0" : "h-[min(40rem,calc(100dvh-12rem))] min-h-96",
              )}
            >
              <RouteMarkers ids={highlight.markers} />
              <ReactFlow<CanvasNode, CanvasEdge>
                aria-label={`${definition.name} stages and routes`}
                nodes={graph.nodes}
                edges={graph.edges}
                nodeTypes={NODE_TYPES}
                edgeTypes={EDGE_TYPES}
                onEdgeMouseEnter={(_, edge) => setHovered(edge.id)}
                onEdgeMouseLeave={() => setHovered(null)}
                connectionLineType={ConnectionLineType.SmoothStep}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                isValidConnection={(connection) => connection.source !== connection.target}
                onDelete={onDelete}
                onInit={(instance) => {
                  flow.current = instance;
                }}
                onDragOver={onDragOver}
                onDrop={onDrop}
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
                  <div className="flex items-center gap-1.5">
                    <Button size="xs" variant="outline" onClick={arrange}>
                      <AlignHorizontalDistributeCenterIcon />
                      Arrange
                    </Button>
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
                    <Button
                      size="icon-xs"
                      variant="outline"
                      aria-label={host ? "Exit full view (Esc)" : "Expand canvas"}
                      onClick={() => setExpanded((value) => !value)}
                    >
                      {host ? <ShrinkIcon /> : <ExpandIcon />}
                    </Button>
                  </div>
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
              roles={stageRoles}
            />
          </div>
        </div>
      </CanvasHighlight>
    </CanvasLabels>
  );
  return host
    ? createPortal(
        <div className="absolute inset-0 z-30 flex flex-col bg-background p-4">{canvas}</div>,
        host,
      )
    : canvas;
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
  const { active, hover } = use(CanvasHighlight);
  // Level with the first outcome, so the main path runs straight from stage to stage.
  const inHandle = <Handle type="target" position={Position.Left} id={IN_HANDLE} />;
  return (
    <div
      className={cn(
        "relative w-56 rounded-lg border bg-card text-card-foreground shadow-xs/5",
        selected ? "border-ring" : "border-border",
      )}
    >
      {data.outcomes.length === 0 ? inHandle : null}
      {/* Only routes are drawn into it; new routes connect on the left. */}
      <Handle
        type="target"
        position={Position.Bottom}
        id={BACK_HANDLE}
        isConnectable={false}
        className="opacity-0"
      />
      <div className="space-y-0.5 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{stageName(id)}</span>
          {data.first ? <Badge variant="outline">First</Badge> : null}
          {data.gate ? <Badge variant="info">Approval</Badge> : null}
        </div>
        <div className="truncate text-xs text-muted-foreground">{roleName(data.role)}</div>
      </div>
      <div className="border-t border-border/50 py-1">
        {data.outcomes.map((outcome, index) => {
          const routeId = workflowRouteId(id, outcome);
          return (
            <div
              key={outcome}
              className={cn(
                "relative px-3 py-0.5 text-right text-xs",
                active === routeId ? "text-foreground" : "text-muted-foreground",
              )}
              onPointerEnter={() => hover(routeId)}
              onPointerLeave={() => hover(null)}
            >
              {/* One line per outcome keeps the node as tall as layout expects. */}
              <span className="block truncate">{humanizeWorkflowId(outcome)}</span>
              {index === 0 ? inHandle : null}
              <Handle type="source" position={Position.Right} id={outcome} />
            </div>
          );
        })}
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
      <Handle type="target" position={Position.Left} id={IN_HANDLE} />
      {stageName(id)}
    </div>
  );
}

// Lanes run outside every node, so routes only need the row's top and bottom.
const selectTop = (state: ReactFlowState) => {
  let top = Infinity;
  for (const node of state.nodeLookup.values()) {
    top = Math.min(top, node.internals.positionAbsolute.y);
  }
  return Number.isFinite(top) ? top : 0;
};
const selectBottom = (state: ReactFlowState) => {
  let bottom = -Infinity;
  for (const node of state.nodeLookup.values()) {
    bottom = Math.max(bottom, node.internals.positionAbsolute.y + (node.measured.height ?? 0));
  }
  return Number.isFinite(bottom) ? bottom : 0;
};

/**
 * A route drawn on its planned tracks and lanes, ending in an arrow. Back
 * routes and loops are dashed and fainter, so the forward path reads first.
 */
function RouteEdgeView({ id, data, sourceX, sourceY, targetX, targetY }: EdgeProps<CanvasEdge>) {
  const top = useStore(selectTop);
  const bottom = useStore(selectBottom);
  const { active, markers } = use(CanvasHighlight);
  if (!data) return null;
  const points = routePoints(
    data,
    { x: sourceX, y: sourceY },
    { x: targetX, y: targetY },
    { top, bottom },
  );
  const label = routeLabelPoint(points);
  const back = data.kind === "back" || data.kind === "loop";
  const lit = active === id;
  return (
    <g opacity={active !== null && !lit ? 0.25 : 1}>
      <BaseEdge
        path={routePath(points)}
        markerEnd={`url(#${lit ? markers.active : back ? markers.back : markers.forward})`}
        style={{
          stroke: lit ? "var(--color-foreground)" : back ? BACK_STROKE : undefined,
          strokeWidth: lit ? 1.5 : 1,
          strokeDasharray: back ? "4 3" : undefined,
        }}
        {...(data.limit !== null
          ? { label: `up to ${data.limit}×`, labelX: label.x, labelY: label.y }
          : {})}
      />
    </g>
  );
}

/** Closed arrowheads for routes, one per color a route can be drawn in. */
function RouteMarkers({
  ids,
}: {
  readonly ids: { forward: string; back: string; active: string };
}) {
  const marker = (id: string, fill: string) => (
    <marker
      id={id}
      viewBox="0 0 10 10"
      refX={10}
      refY={5}
      markerWidth={9}
      markerHeight={9}
      markerUnits="userSpaceOnUse"
      orient="auto-start-reverse"
    >
      <path d="M 0 1 L 10 5 L 0 9 z" style={{ fill }} />
    </marker>
  );
  return (
    <svg aria-hidden className="pointer-events-none absolute size-0">
      <defs>
        {marker(ids.forward, "var(--color-muted-foreground)")}
        {marker(ids.back, BACK_STROKE)}
        {marker(ids.active, "var(--color-foreground)")}
      </defs>
    </svg>
  );
}
