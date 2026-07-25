import { ko } from "../../i18n/ko";
// Straight from the module, not the `../composer` barrel: this file is pure
// logic and the barrel drags TokenComposer's React tree in behind it.
import { TONE, kindFromCode, type ObjectKind, type Tone } from "../composer/objectKinds";
import { registeredObjectType, registeredObjectTypes } from "../ontology/typeRegistrySource";

/**
 * Backend object-kind slugs the console object card operates on — the canonical
 * `RESOLVABLE_KIND_AUTH` set from `backend/app/src/objects.rs` (work_order,
 * equipment, account, support_ticket, org_unit, person, approval_run, passkey,
 * consent). The card's `target.kind` is one of these slugs; resolveObject,
 * lifecycle, and object-links all key off the same slug (§4-18: one kind name,
 * not a per-endpoint fork).
 *
 * The static tables below are the OFFLINE FLOOR, not the whole truth (L-F3): a
 * type registered through the Ontology Manager resolves its slug and its label
 * from the object-type registry, so a new object code costs no edit here. The
 * registry is the authority on prefix -> kind; whether that kind is resolvable
 * stays the backend's decision (`RESOLVABLE_KIND_AUTH` + PBAC), exactly as
 * `ontology/codeGrammar` states for recognition: parsing is not authorization.
 */
export interface SlugMeta {
  tone: Tone;
  labelKey: keyof typeof ko.console.objectCard.kinds;
}

const SLUG_META: Partial<Record<string, SlugMeta>> = {
  work_order: { tone: "info", labelKey: "work_order" },
  equipment: { tone: "neutral", labelKey: "equipment" },
  account: { tone: "purple", labelKey: "account" },
  support_ticket: { tone: "warn", labelKey: "support_ticket" },
  org_unit: { tone: "neutral", labelKey: "org_unit" },
  person: { tone: "purple", labelKey: "person" },
  approval_run: { tone: "accent", labelKey: "approval_run" },
  passkey: { tone: "ok", labelKey: "passkey" },
  consent: { tone: "ok", labelKey: "consent" },
};

/**
 * Korean label for a backend slug. A seeded slug uses its ko string; a slug the
 * card has no ko string for uses the registry's own description (the same
 * backend-authored name `modules/typeRegistry` shows for a dynamic type), and
 * only then the raw slug. Never throws — a link edge may reference a kind the
 * card knows no label for.
 */
export function slugLabel(slug: string): string {
  const meta = SLUG_META[slug];
  if (meta) return ko.console.objectCard.kinds[meta.labelKey];
  return registeredObjectType(slug)?.description.trim() || slug;
}

/** Chip tone triplet for a slug (neutral for unknown). */
export function slugTone(slug: string) {
  return TONE(SLUG_META[slug]?.tone ?? "neutral");
}

/**
 * Seeded composer kind -> backend slug, for bare-code relation drawing
 * (kindFromCode gives the composer kind; this maps the linkable subset to the
 * backend slug object-links expects). Keyed by `ObjectKind`, so a typo can no
 * longer sit here silently making a kind unlinkable — the case L-F3 was called
 * to fix. Codes outside this table fall through to the registry below.
 */
const COMPOSER_KIND_TO_SLUG: Partial<Record<ObjectKind, string>> = {
  workOrder: "work_order",
  support: "support_ticket",
  approval: "approval_run",
  person: "person",
  org: "org_unit",
};

/**
 * Registered-type slug for a code's prefix, from the runtime object-type
 * registry — the path that makes a NEW object code cost zero frontend edits.
 * Only `active` types resolve (deny-by-default: a draft or archived type takes
 * no new edges). Both sides are compared dash-stripped because the registry
 * stores the trailing-dash form while codes carry it as a separator.
 */
function registeredSlugForCode(code: string): string | undefined {
  const dashIndex = code.indexOf("-");
  if (dashIndex <= 0) return undefined;
  const prefix = code.slice(0, dashIndex);
  return registeredObjectTypes()?.find(
    (type) => type.status === "active" && type.codePrefix?.replace(/-+$/, "") === prefix,
  )?.kind;
}

/** Resolve a typed bare code to a linkable backend (slug, id) pair, or
 * `undefined` when the code's kind isn't a resolvable object (unlinkable). */
export function linkTargetFromCode(code: string): { kind: string; id: string } | undefined {
  const composerKind = kindFromCode(code);
  const slug =
    (composerKind ? COMPOSER_KIND_TO_SLUG[composerKind] : undefined) ?? registeredSlugForCode(code);
  if (!slug) return undefined;
  // ponytail: dst_id is the issued code as typed — the object-links backend
  // accepts "a UUID or issued code". Canonical code->row-id normalization is a
  // BE-OBJ (canonical codes) concern; note the openapi gap if far-end
  // resolution needs the bare request_no instead of the prefixed code.
  return { kind: slug, id: code.trim() };
}
