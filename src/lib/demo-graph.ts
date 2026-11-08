import type { ArchDiff } from "../../shared/arch/diff";
import type { ArchEdge, ArchNode, ArchSnapshot, Intent, VersionState } from "../../shared/arch/types";
import type { GraphReplay } from "./graph";

const STAMP = "2026-11-04T09:30:00.000Z";
const ACTOR = { id: "user:demo", kind: "user" as const, name: "Demo architect", email: "" };

function node(
  id: string,
  level: ArchNode["level"],
  kind: ArchNode["kind"],
  parentId: string | null,
  name: string,
  path: string,
  file: string,
  responsibility: string,
  extra: Partial<ArchNode> = {},
): ArchNode {
  return {
    id,
    level,
    kind,
    parentId,
    name,
    path,
    file,
    symbol: "",
    responsibility,
    intentId: null,
    status: "active",
    metadata: {},
    introducedIn: "demo-v1",
    updatedIn: "demo-v1",
    lastTouchedIn: null,
    ...extra,
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: ArchEdge["kind"],
): ArchEdge {
  return { id, from, to, kind, metadata: {}, introducedIn: "demo-v1" };
}

function version(id: string, ordinal: number): VersionState {
  return {
    id,
    intentId: id === "demo-v2" ? "intent:demo-v2" : "intent:demo-v1",
    status: "approved",
    ordinal,
    ops: [],
    touches: [],
    decisions: [],
    implementations: [],
    baseHash: null,
    targetHash: null,
    diffHash: null,
    createdAt: STAMP,
    updatedAt: STAMP,
  };
}

const system = node(
  "demo:system:shop",
  "L0",
  "system",
  null,
  "Shop",
  "src",
  "",
  "A small storefront used to demonstrate architecture review.",
);
const catalog = node(
  "demo:module:catalog",
  "L0",
  "module",
  "demo:system:shop",
  "Catalog",
  "src/modules/catalog",
  "",
  "Browse products, filters and product details.",
);
const checkout = node(
  "demo:module:checkout",
  "L0",
  "module",
  "demo:system:shop",
  "Checkout",
  "src/modules/checkout",
  "",
  "Cart, payment session and order confirmation.",
);
const shared = node(
  "demo:module:shared",
  "L0",
  "module",
  "demo:system:shop",
  "Shared UI",
  "src/modules/shared",
  "",
  "Reusable presentation primitives.",
);
const stripe = node(
  "demo:external:stripe",
  "L0",
  "external",
  null,
  "Stripe API",
  "external/stripe",
  "",
  "Hosted payment sessions.",
);

const productGrid = node(
  "demo:l1:product-grid",
  "L1",
  "component",
  "demo:module:catalog",
  "ProductGrid",
  "src/modules/catalog/ProductGrid.tsx",
  "src/modules/catalog/ProductGrid.tsx",
  "Renders the product list and exposes selection to the catalog page.",
  { symbol: "ProductGrid", metadata: { exports: ["ProductGrid", "ProductGridProps"] } },
);
const useCatalog = node(
  "demo:l1:use-catalog",
  "L1",
  "hook",
  "demo:module:catalog",
  "useCatalog",
  "src/modules/catalog/useCatalog.ts",
  "src/modules/catalog/useCatalog.ts",
  "Loads products and owns filter state.",
  { symbol: "useCatalog" },
);
const checkoutForm = node(
  "demo:l1:checkout-form",
  "L1",
  "component",
  "demo:module:checkout",
  "CheckoutForm",
  "src/modules/checkout/CheckoutForm.tsx",
  "src/modules/checkout/CheckoutForm.tsx",
  "Collects payment details and starts a checkout session.",
  { symbol: "CheckoutForm", metadata: { exports: ["CheckoutForm"] } },
);
const checkoutService = node(
  "demo:l1:checkout-service",
  "L1",
  "service",
  "demo:module:checkout",
  "checkoutService",
  "src/modules/checkout/checkout-service.ts",
  "src/modules/checkout/checkout-service.ts",
  "Creates Stripe sessions and confirms orders.",
  { symbol: "checkoutService" },
);
const cartStore = node(
  "demo:l1:cart-store",
  "L1",
  "store",
  "demo:module:checkout",
  "cartStore",
  "src/modules/checkout/cart-store.ts",
  "src/modules/checkout/cart-store.ts",
  "Persists cart lines and totals.",
  { symbol: "cartStore" },
);
const button = node(
  "demo:l1:button",
  "L1",
  "component",
  "demo:module:shared",
  "Button",
  "src/modules/shared/Button.tsx",
  "src/modules/shared/Button.tsx",
  "Accessible button primitive with variants.",
  { symbol: "Button", metadata: { exports: ["Button"] } },
);

const renderGrid = node(
  "demo:facet:product-grid.render",
  "facet",
  "method",
  "demo:l1:product-grid",
  "render",
  "src/modules/catalog/ProductGrid.tsx#render",
  "src/modules/catalog/ProductGrid.tsx",
  "Renders one card per product.",
  { symbol: "ProductGrid.render" },
);
const gridItems = node(
  "demo:facet:product-grid.items",
  "facet",
  "field",
  "demo:l1:product-grid",
  "items",
  "src/modules/catalog/ProductGrid.tsx#items",
  "src/modules/catalog/ProductGrid.tsx",
  "Products passed by the catalog page.",
  { symbol: "ProductGrid.items" },
);
const gridSelected = node(
  "demo:facet:product-grid.selected",
  "facet",
  "property",
  "demo:l1:product-grid",
  "selected",
  "src/modules/catalog/ProductGrid.tsx#selected",
  "src/modules/catalog/ProductGrid.tsx",
  "Currently highlighted product id.",
  { symbol: "ProductGrid.selected" },
);
const createSession = node(
  "demo:facet:checkout.create-session",
  "facet",
  "method",
  "demo:l1:checkout-service",
  "createSession",
  "src/modules/checkout/checkout-service.ts#createSession",
  "src/modules/checkout/checkout-service.ts",
  "Creates a payment session for the current cart.",
  { symbol: "checkoutService.createSession" },
);
const cartTotal = node(
  "demo:facet:cart.total",
  "facet",
  "property",
  "demo:l1:cart-store",
  "total",
  "src/modules/checkout/cart-store.ts#total",
  "src/modules/checkout/cart-store.ts",
  "Derived cart total in minor units.",
  { symbol: "cartStore.total" },
);

const reviews = node(
  "demo:module:reviews",
  "L0",
  "module",
  "demo:system:shop",
  "Reviews",
  "src/modules/reviews",
  "",
  "Product reviews with moderation states.",
  { intentId: "intent:demo-v2", introducedIn: "demo-v2", updatedIn: "demo-v2" },
);
const reviewList = node(
  "demo:l1:review-list",
  "L1",
  "component",
  "demo:module:reviews",
  "ReviewList",
  "src/modules/reviews/ReviewList.tsx",
  "src/modules/reviews/ReviewList.tsx",
  "Lists approved reviews and their ratings.",
  {
    symbol: "ReviewList",
    intentId: "intent:demo-v2",
    introducedIn: "demo-v2",
    updatedIn: "demo-v2",
    metadata: { exports: ["ReviewList"] },
  },
);
const reviewRender = node(
  "demo:facet:review-list.render",
  "facet",
  "method",
  "demo:l1:review-list",
  "render",
  "src/modules/reviews/ReviewList.tsx#render",
  "src/modules/reviews/ReviewList.tsx",
  "Renders one review row per approved review.",
  {
    symbol: "ReviewList.render",
    intentId: "intent:demo-v2",
    introducedIn: "demo-v2",
    updatedIn: "demo-v2",
  },
);

const baseEdges: Record<string, ArchEdge> = {
  "demo:edge:grid-catalog": edge(
    "demo:edge:grid-catalog",
    productGrid.id,
    useCatalog.id,
    "uses",
  ),
  "demo:edge:grid-button": edge(
    "demo:edge:grid-button",
    productGrid.id,
    button.id,
    "renders",
  ),
  "demo:edge:form-service": edge(
    "demo:edge:form-service",
    checkoutForm.id,
    checkoutService.id,
    "uses",
  ),
  "demo:edge:service-cart": edge(
    "demo:edge:service-cart",
    checkoutService.id,
    cartStore.id,
    "reads",
  ),
  "demo:edge:service-stripe": edge(
    "demo:edge:service-stripe",
    checkoutService.id,
    stripe.id,
    "depends_on",
  ),
  "demo:edge:checkout-catalog": edge(
    "demo:edge:checkout-catalog",
    checkout.id,
    catalog.id,
    "depends_on",
  ),
};

const reviewEdge = edge(
  "demo:edge:reviews-button",
  reviewList.id,
  button.id,
  "renders",
);

const baseNodes = [
  system,
  catalog,
  checkout,
  shared,
  stripe,
  productGrid,
  useCatalog,
  checkoutForm,
  checkoutService,
  cartStore,
  button,
  renderGrid,
  gridItems,
  gridSelected,
  createSession,
  cartTotal,
];

function snapshot(
  nodes: ArchNode[],
  edges: Record<string, ArchEdge>,
): ArchSnapshot {
  const demoIntentV1: Intent = {
    id: "intent:demo-v1",
    versionId: "demo-v1",
    title: "Open the storefront",
    goal: "Ship a browsable catalog and a working checkout.",
    tasks: [],
    nodeIntents: [
      {
        nodeId: productGrid.id,
        statement: "Show the product grid.",
        invariants: [],
        acceptance: [],
      },
      {
        nodeId: checkoutService.id,
        statement: "Create a payment session from the cart.",
        invariants: [],
        acceptance: [],
      },
    ],
    author: ACTOR,
    createdAt: STAMP,
    mode: "code",
  };
  const demoIntentV2: Intent = {
    id: "intent:demo-v2",
    versionId: "demo-v2",
    title: "Add product reviews",
    goal: "Let shoppers read approved reviews on every product.",
    tasks: [],
    nodeIntents: [
      {
        nodeId: reviews.id,
        statement: "Add a Reviews module owned by the shop system.",
        invariants: ["Reviews consume the shared Button primitive."],
        acceptance: ["ReviewList is reachable from the catalog."],
      },
      {
        nodeId: productGrid.id,
        statement: "Expose review entry points from the product grid.",
        invariants: [],
        acceptance: [],
      },
    ],
    author: ACTOR,
    createdAt: STAMP,
    mode: "code",
  };
  return {
    schemaVersion: 1,
    nodes: Object.fromEntries(nodes.map((item) => [item.id, item])),
    edges,
    intents: {
      [demoIntentV1.id]: demoIntentV1,
      [demoIntentV2.id]: demoIntentV2,
    },
    touches: {},
    versions: {
      "demo-v1": version("demo-v1", 1),
      "demo-v2": version("demo-v2", 2),
    },
    decisions: {},
    implementations: {},
    lastRecordId: "demo:record:42",
    recordCount: 42,
  };
}

/**
 * A small, self-contained architecture fixture for the canvas. It is only a
 * renderer-side demo: it never claims to be a project, never writes a WAL, and
 * cannot start an approval or implementation turn.
 */
export function buildDemoGraph(): { replay: GraphReplay; snapshot: ArchSnapshot } {
  const baseSnapshot = snapshot(baseNodes, baseEdges);
  const targetNodes = [...baseNodes, reviews, reviewList, reviewRender];
  const targetSnapshot = snapshot(targetNodes, {
    ...baseEdges,
    [reviewEdge.id]: reviewEdge,
  });
  const beforeGrid = {
    ...productGrid,
    responsibility: "Renders the product list.",
  };
  const diff: ArchDiff = {
    nodes: {
      [reviews.id]: {
        id: reviews.id,
        change: "added",
        before: null,
        after: reviews,
        fields: [],
        propagated: false,
      },
      [reviewList.id]: {
        id: reviewList.id,
        change: "added",
        before: null,
        after: reviewList,
        fields: [],
        propagated: false,
      },
      [reviewRender.id]: {
        id: reviewRender.id,
        change: "added",
        before: null,
        after: reviewRender,
        fields: [],
        propagated: false,
      },
      [productGrid.id]: {
        id: productGrid.id,
        change: "modified",
        before: beforeGrid,
        after: productGrid,
        fields: ["responsibility"],
        propagated: false,
      },
    },
    edges: {
      [reviewEdge.id]: {
        id: reviewEdge.id,
        change: "added",
        before: null,
        after: reviewEdge,
        fields: [],
      },
    },
    colors: {
      [system.id]: "modified",
      [catalog.id]: "modified",
      [productGrid.id]: "modified",
      [reviews.id]: "added",
      [reviewList.id]: "added",
      [reviewRender.id]: "added",
    },
    summary: { added: 3, removed: 0, modified: 2, affected: 6 },
  };
  return {
    replay: {
      id: "demo-v2",
      baseSnapshot,
      targetSnapshot,
      diff,
    },
    snapshot: targetSnapshot,
  };
}
