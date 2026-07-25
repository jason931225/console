import { describe, expect, it, vi } from "vitest";

import { ontologyEntityRef } from "./entityRef";
import { createOntologyObjectRuntime } from "./objectRuntime";

describe("createOntologyObjectRuntime", () => {
  it("omits cross-authority references before issuing any backend read", async () => {
    const get = vi.fn();
    const runtime = createOntologyObjectRuntime({
      api: { GET: get } as never,
      authorityKey: "authority-a",
      tenantScopeKey: "tenant-a",
      detailForObjectType: () => undefined,
      linkTitleById: new Map(),
    });
    const ref = ontologyEntityRef({ tenantScopeKey: "tenant-b", authorityKey: "authority-b", objectTypeId: "type-a", id: "object-a" })!;
    await expect(runtime.resolve(ref, { signal: new AbortController().signal })).resolves.toBeUndefined();
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects an already-aborted resolution without exposing a descriptor", async () => {
    const runtime = createOntologyObjectRuntime({
      api: {} as never,
      authorityKey: "authority-a",
      tenantScopeKey: "tenant-a",
      detailForObjectType: () => undefined,
      linkTitleById: new Map(),
    });
    const controller = new AbortController();
    controller.abort();
    const ref = ontologyEntityRef({ tenantScopeKey: "tenant-a", authorityKey: "authority-a", objectTypeId: "type-a", id: "object-a" })!;
    await expect(runtime.resolve(ref, { signal: controller.signal })).resolves.toBeUndefined();
  });
});
