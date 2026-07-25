import {
  getInstance,
  getInstanceHistory,
  type ObjectTypeDetailWire,
  traverseInstance,
} from "../../api/ontology";
import type { ConsoleApiClient } from "../../api/client";
import { objectCardDescriptorFrom } from "../ontology";
import type { ObjectCardDescriptor } from "../objectcard/types";
import type { EntityRef } from "./entityRef";

export interface ObjectRuntimePort {
  readonly authority: EntityRef["authority"];
  resolve(
    ref: EntityRef,
    options: { signal: AbortSignal },
  ): Promise<ObjectCardDescriptor | undefined>;
}

function abortError(): DOMException {
  return new DOMException("Object resolution was superseded", "AbortError");
}

async function abortable<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortError();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void value.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Ontology adapter: all three detail reads are scoped by the authenticated API
 * client. A reference from another authority is omitted before any read, so it
 * cannot reveal existence/counts across a tenant or session transition.
 */
export function createOntologyObjectRuntime(input: {
  api: ConsoleApiClient;
  authorityKey: string;
  tenantScopeKey: string;
  detailForObjectType: (objectTypeId: string) => ObjectTypeDetailWire | undefined;
  linkTitleById: ReadonlyMap<string, string>;
}): ObjectRuntimePort {
  const authorityKey = input.authorityKey;
  const tenantScopeKey = input.tenantScopeKey;
  return {
    authority: "ontology",
    async resolve(ref, { signal }) {
      if (
        ref.authority !== "ontology" ||
        ref.authorityKey !== authorityKey ||
        ref.tenantScopeKey !== tenantScopeKey ||
        signal.aborted
      ) {
        return undefined;
      }
      const [state, history, neighbors] = await abortable(
        Promise.all([
          getInstance(input.api, ref.id),
          getInstanceHistory(input.api, ref.id),
          traverseInstance(input.api, ref.id, { depth: 1 }),
        ]),
        signal,
      );
      if (
        signal.aborted ||
        state.instance.object_type_id !== ref.objectTypeId
      ) {
        return undefined;
      }
      return objectCardDescriptorFrom({
        state,
        history,
        neighbors,
        detail: input.detailForObjectType(ref.objectTypeId),
        linkTitleById: input.linkTitleById,
      });
    },
  };
}
