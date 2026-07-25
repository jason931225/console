import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConsoleApiClient } from "../../api/client";
import {
  canonicalObjectType,
  loadCanonicalObjectType,
  resetObjectTypeRegistry,
} from "./typeRegistrySource";

const DETAIL = {
  object_type: {
    id: "00000000-0000-4000-8000-000000000701",
    stable_key: "widget",
    title: "Widget",
    backing_kind: "instance",
    schema_version: 7,
    lifecycle_state: "published",
    key_write_revision: 7,
    key_write_etag: '"widget-r7"',
  },
  title_property_key: "label",
  backing_table: null,
  primary_key_property: null,
  properties: [
    {
      id: "00000000-0000-4000-8000-000000000702",
      key: "label",
      title: "Label",
      field_type: "text",
      config: {},
      backing_column: null,
      required: true,
      in_property_policy: false,
    },
  ],
  links: [],
  actions: [],
  analytics: [],
};

const INSTANCE = {
  instance: {
    id: "00000000-0000-4000-8000-000000000703",
    object_type_id: DETAIL.object_type.id,
    title: "Real widget",
    current_revision_id: "00000000-0000-4000-8000-000000000704",
    lifecycle_state: "active",
  },
  revision: {
    id: "00000000-0000-4000-8000-000000000704",
    instance_id: "00000000-0000-4000-8000-000000000703",
    version: 2,
    attributes: { label: "Real label" },
    valid_from: "2026-07-25T00:00:00Z",
    valid_to: null,
    action_type_id: null,
    actor: null,
    reason: null,
    prev_hash: "0".repeat(64),
    row_hash: "a".repeat(64),
  },
};

afterEach(() => {
  resetObjectTypeRegistry();
  vi.restoreAllMocks();
});

describe("canonical dynamic object-type source", () => {
  it("uses the canonical detail's real version UUID to load instances and caches the governed schema only in its authority scope", async () => {
    const GET = vi.fn()
      .mockResolvedValueOnce({ data: DETAIL, response: new Response() })
      .mockResolvedValueOnce({ data: [INSTANCE], response: new Response() });
    const api = { GET } as unknown as ConsoleApiClient;

    await expect(loadCanonicalObjectType(api, "widget", "tenant-a:session-1")).resolves.toMatchObject({
      definition: {
        id: DETAIL.object_type.id,
        schemaVersion: 7,
        properties: [{ key: "label", title: "Label" }],
      },
      instances: [INSTANCE],
    });
    expect(GET.mock.calls[1]?.[1]).toMatchObject({
      params: { query: { type: DETAIL.object_type.id } },
    });
    expect(canonicalObjectType("widget", "tenant-a:session-1")?.definition.schemaVersion).toBe(7);
    expect(canonicalObjectType("widget", "tenant-b:session-1")).toBeUndefined();
  });

  it.each([403, 404])("does not retain a canonical result after a %i response", async (status) => {
    const api = {
      GET: vi.fn().mockResolvedValue({
        data: undefined,
        error: { error: { code: "DENIED", message: "denied" } },
        response: new Response(null, { status }),
      }),
    } as unknown as ConsoleApiClient;

    await expect(loadCanonicalObjectType(api, "widget", "tenant-a:session-1")).rejects.toMatchObject({ status });
    expect(canonicalObjectType("widget", "tenant-a:session-1")).toBeUndefined();
  });

  it("fails closed when the instance API returns a different type-version UUID", async () => {
    const GET = vi.fn()
      .mockResolvedValueOnce({ data: DETAIL, response: new Response() })
      .mockResolvedValueOnce({
        data: [{ ...INSTANCE, instance: { ...INSTANCE.instance, object_type_id: "wrong-version" } }],
        response: new Response(),
      });
    const api = { GET } as unknown as ConsoleApiClient;

    await expect(loadCanonicalObjectType(api, "widget", "tenant-a:session-1")).rejects.toThrow(
      "type version mismatch",
    );
    expect(canonicalObjectType("widget", "tenant-a:session-1")).toBeUndefined();
  });
});
