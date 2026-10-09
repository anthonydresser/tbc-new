# Port Plan: Fork Features onto Upstream's New UI

**Context:** Upstream (`wowsims/tbc-new@d708f839d`) deleted the legacy UI tree (`ui/core`, `ui/scss`, per-class dirs) and replaced it with a React 19 + Zustand + Tailwind v4 tree (`ui/app`, `ui/features`, `ui/sim`, `ui/ui-kit`, `ui/specs`). The fork's 7 commits (`dd25f5787..master` pre-port) live entirely in the deleted tree. This plan re-implements each fork feature on the new architecture.

**Strategy:** Fork history is preserved on branch `backup/legacy-ui`; `master` is reset to `upstream/master` and each feature below lands as a fresh commit (or commit group). No legacy UI files are resurrected.

**New-tree conventions to follow:** path aliases (`@sim`, `@generated`, `@ui-kit`, `@features`, `@app`, `@i18n`); layering `generated → worker → {sim, i18n} → ui-kit → features → app → specs`; `features/*/model/` must be DOM-free (browser access via injected `Env`); Tailwind only (no SCSS); i18n keys added to `assets/locales/en/translation.json` **and** `schemas/translation.schema.json` (validated by `npm run test:locales` with `additionalProperties: false`); TS protos regenerate via `make proto` into `ui/generated/proto/`.

---

## 1. Proto & tooling changes (foundation — land first)

### 1a. `proto/api.proto`

Upstream's `BulkSettings` uses fields 1–13 (3–7 reserved, 8–12 freeze-*, 13 `use_legacy_bulk_sim`). Fork's fields collide at 13, so renumber (proto JSON storage uses field names, so renumbering is storage-safe):

```proto
enum BulkConstraintComparison {
	BULK_CONSTRAINT_COMPARISON_UNSPECIFIED = 0;
	BULK_CONSTRAINT_COMPARISON_GREATER_OR_EQUAL = 1;
	BULK_CONSTRAINT_COMPARISON_LESS_OR_EQUAL = 2;
	BULK_CONSTRAINT_COMPARISON_EQUAL = 3;
}
message BulkConstraint {
	Stat stat = 1;
	BulkConstraintComparison comparison = 2;
	double value = 3;
}
message BulkEnchantSelection {
	int32 effect_id = 1;
	int32 type = 2;
}
message GemSocket {
	ItemSlot slot = 1;
	int32 socket_idx = 2;
}
// in BulkSettings:
bool optimize_gems = 14;
repeated BulkConstraint constraints = 15;
repeated BulkEnchantSelection allowed_enchants = 16;
bool optimize_enchants = 17;
// in ReforgeSettings (api.proto, currently ends at ep_stats = 10):
repeated GemSocket frozen_gem_sockets = 11;
```

Note: fork had `GemSocket`+`frozen_gem_sockets` in `proto/ui.proto`'s copy of `ReforgeSettings`; upstream moved `ReforgeSettings` to `api.proto` (referenced from `ui.proto` via `IndividualSimSettings.reforge_settings = 18` and `ReforgeOptimizeRequest.settings`), so both changes land in `api.proto`.

### 1b. Wickids BiS list generator + assets — portable as-is

- `tools/bis_list_generator/generate_wickids.py` (new, 548 lines): fetches Lua from `Wicksmods/WickidsTBCBISTracker`, parses, maps to sim `Spec` ints, emits `assets/bis_lists/wickids/<spec>_p<1-5>.json` + `assets/bis_lists/index.json` manifest.
- `makefile`: `bis-lists` target; `package.json`: `generate:bis-lists` script.
- `assets/bis_lists/**`: ~75 generated preset files (regenerable via the tool, so these can be re-generated or cherry-picked verbatim from `backup/legacy-ui`).

### 1c. TBC token gear sources

- `tools/database/atlasloot.go` (+366 lines): `readAtlasLootTBCData`, `parseTBCAtlasLootIDs`, `parseTBCSourceEntries` (token→gear `TokenMap`, 5-hop indirection), `parseTBCInstanceData`, `isTBCItemToken`, `loadTBCItemNames`, `tbcDifficulty`. Fork diff applies with manual merge (upstream modified the file since merge-base).
- Runtime fallback: `ui/core/proto_utils/tbc_token_sources.ts` (2801-line generated table + `applyTBCGearTokenSources(db)`) must be re-homed to `ui/sim/proto/tbc_token_sources.ts`, called from the new `ui/sim/proto/database.ts` `Database.get()` (both JSON and binary paths) and `loadLeftoversIfNecessary`. Only needed if the checked-in DB is not regenerated with the atlasloot change; port it anyway for robustness (old cached DBs).

---

## 2. Frozen gem sockets (fork F1)

**New-tree reality:** the gem optimizer is now the Go backend (`sim/core/reforge_optimizer/`, HiGHS LP) driven by `sim.reforgeOptimize(ReforgeOptimizeConfig)`; upstream already supports frozen _item slots_ (`ReforgeSettings.frozen_item_slots`, `ReforgeFrozenSlots` checkbox grid). The fork freezes _individual sockets_.

**Implementation:**

- **Backend:** in `sim/core/reforge_optimizer/` (`optimizer.go`, `gear.go` — see `frozenItemSlots(settings)` and the `o.frozenSlots[loc.slot]` guard): treat sockets listed in `settings.frozen_gem_sockets` as fixed — excluded from gem-candidate variable generation; their currently-socketed gems count toward unique-gem budgets and socket-bonus evaluation (mirroring the fork's client-side `setupGemLP` semantics: `frozenSocketBonusImpossible`, unique-gem accounting, skip `SocketBonus_` variable when impossible).
- **UI:** extend `features/reforge`'s frozen-slots section (`ReforgeFrozenSlots`) with a per-socket sub-grid: per equipped item with sockets, one clickable socket icon per socket (lock overlay when frozen, using Tailwind + FontAwesome lock `\f023` equivalent in the new icon system). State lives in `ReforgeSlice` (`sim_store.ts`) as `frozenGemSockets: string[]` (`"${slot}_${socketIdx}"` keys), included in the settings autosave envelope and mapped into `ReforgeOptimizeConfig` in `features/reforge/model/reforge_optimizer.ts`.
- **Consumers:** bulk sim and upgrade finder fallback gemming must respect frozen sockets when filling empty sockets (see §3/§4 — a `fillSocketsWithGems(gemsByColor, frozenSockets)` helper in the new `sim/proto/gear.ts` + `removeGemsExcept` on `EquippedItem`).

---

## 3. Bulk sim: stat constraints, enchant optimization, optimize-gems toggle (fork F7)

New bulk sim lives in `features/bulk/` (model: `run.ts`, `core_sim.ts` → `sim.runBulkSim(...)`; settings in `BulkSlice` + `BulkSettings` proto; UI: `features/bulk/components/BulkSettings`, tab in `app/tabs/BulkTabBody.tsx`).

- **Optimize-gems toggle** (`optimize_gems`, default **true**): when off, skip the reforge/gem pre-pass in `runBulkBatch`/`sim.runBulkSim` (pass no `reforgeConfig`).
- **Stat constraints** (`constraints`): editor section in `BulkSettings` — rows of {Stat dropdown (`translateStat`), comparison (≥/≤/=), integer value}. During a run, after the reforge pre-pass, check each candidate via `sim.getCharacterStatsForGear(gear)` `finalStats` against `meetsConstraint` (equality tolerance 0.001); only passing sets get full sims. Progress dialog gains "Checking constraints" stage; all-fail → warning toast (`no_constraints_met`).
- **Enchant optimization** (`optimize_enchants` + `allowed_enchants`, default false): allow-list chips UI + "Add enchant" dialog (searchable list of eligible enchants: `db.getAllEnchants()` filtered by `canEquipEnchant` and applicability to equipped item types, each row shows computed EP). Algorithm (final fork form, post-bd77a8d3c): per slot, greedily pick the allow-listed enchant with highest **marginal EP** — `computeEquippedItemEP(item.withEnchant(e)) - computeEquippedItemEP(current)` where `computeEquippedItemEP = player.computeItemEP(item, slot) + player.computeStatsEP(gem stats)` — applying each choice immediately so later slots see earlier ones. Progress stage "Optimizing enchants".
- **Database helpers:** port `enchantEffectIdToEnchant(effectId, type?)` and `getAllEnchants()` (dedup by effectId+type) into `ui/sim/proto/database.ts`.
- **Player helper:** new tree's equivalent of `getRandomSuffixes` must not filter non-positive-EP suffixes (resistance suffixes like "of Shadow Protection" must appear).
- **Result highlighting:** new `BulkResultRow` gets the orange-border "enchant/gems changed" styling fork added to `_bulk_tab.scss` — re-expressed in Tailwind.
- Enchant EP math helpers (`computeEnchantEP`, `computeItemEP`, `computeStatsEP`) — verify existence in new `sim/player/`; port from old `ui/core/player.tsx` if missing.

## 4. Upgrade Finder tab (fork F2 + F3 + F4 + F6 + F9) — the big one

Entirely missing upstream. New `features/upgrades/` (model + components), registered as a 7th tab in `app/SimTabsSection.tsx` after `bulk-tab`.

**Core (fork F2):**

- Setup sub-tab: `BulkItemSearch`-equivalent (reuse `features/bulk` search, or extract the shared search into a host-agnostic component per the fork's `BulkItemSearchHost` refactor), candidate list rows (new `ui-kit/ItemCell` / gear feature's item rendering), per-candidate enchant button (opens `SelectorModal` on its Enchants tab), remove button.
- Settings panel: candidate-sim counter, Fallback Gems row (5 socket pickers by color — reuse gear feature's gem picking / `QuickGemList`/`GemSummary` modal pieces), Optimize Gems toggle (default false), run button.
- Run loop (`features/upgrades/model/run.ts`): baseline sim via `host.runGearSim`; per candidate × eligible slot, `buildCandidateGear` (inherit slot's gems/enchant, apply `selectedEnchant`, restore random suffix, `fillSocketsWithGems` respecting frozen sockets), optional `host.reforger.optimizeReforges` pass, sim, best slot per candidate, sort by delta. Abort machinery via `sim/sim_runs.ts` / abort signals like `features/bulk/model/run.ts`. Progress via ui-kit `ProgressTrackerDialog`.
- Results sub-tab: table Rank / Item / Slot / DPS / Delta / Source / Action (Equip → apply gear + jump to gear tab; Diff modal; Remove → drop candidate+results without re-sim). Footer: "Current Gear" baseline row (+ BiS reference row when §4d enabled).
- Unsaved-run persistence (`upgrade-settings.v1` via `host.getStorageKey`, quota-safe with error toast, `.corrupt-backup` on unparseable JSON, `metricsToJson` stripping `hist`/`allValues`, `Database.loadLeftoversIfNecessary` for leftover items).

**BiS list import + presets (F3):**

- `features/upgrades/model/bis_list_parser.ts` — port `parseBisListJson` (slot aliases, id/name resolution incl. leftover DB, per-entry validation, error taxonomy) and `bis_list_presets.ts` (manifest fetch of `/tbc/assets/bis_lists/index.json`, per-spec filter, phase sort, `loadBisListPreset`).
- Import UI: the new importer framework (`ImporterDefinition`, `features/import-export/importers/`) is geared at whole-character imports; the BiS-list importer instead lives inside the upgrade tab as a ui-kit `Dialog` with paste/upload, following the fork's `BisListJsonImporter` behavior (partial-error warning toast, first-5-errors + "N more").
- Preset phase dropdown + "Load Preset" button in the upgrade tab toolbar.

**Saved runs (F4):**

- Use the new saved-data stack: `useSavedData` (`ui-kit/hooks`) + `SavedDataPanel` in the upgrade tab's settings column. `SavedUpgradeRun {name, timestamp, items, fallbackGems, optimizeGems, compareBisEnabled, bisReferenceName/IsPreset, baselineResult, bisResult, upgradeResults[]}` serialized as JSON (custom codec — it isn't a proto message; `useSavedData` accepts `{toJson, fromJson}` codecs).
- Guards: block list mutation during runs (`busy_while_running` toast); unsaved-changes `confirm()` on load; skipped-item count toast on restore; storage-quota error surfacing (new `useSavedData` already skips unparseable entries and patches records — verify quota behavior matches, extend if not).

**Copy enchants (F6):** toolbar button; per candidate × eligible slot, copy equipped item's enchant when `enchantAppliesToItem(enchant, candidate.item)` (port that helper to `sim/proto/utils.ts` if absent); toast with applied/skipped counts.

**BiS comparison + addon export (F9):**

- "Compare against gear set" toggle + dropdown (repopulated on focus; optgroups for build presets — from `individualConfig.presets.gear`, with name de-dup via group/phase/numbering — and saved gear sets read via `useSavedData` on `host.getSavedGearStorageKey()`; values encode `preset:<label>` / `saved:<name>`).
- Run: one extra sim of the reference set as-saved; each candidate also simmed swapped onto the reference (skip `isBisIdentitySwap` → `bisDelta = 0`), inheriting reference slot's gems/enchant. Counter shows `2x candidate sims + 1`.
- Results: "vs BiS" column + bold BiS-reference footer row.
- "Export to Addon": new `ExporterDefinition`-style dialog producing the WoWSimsUpgradeList string — `WWSULv2|list|spec|ts|baselineDps` / `WWSULv3|…|bisDps` with `slot:itemId:enchantName:gemIds:delta[:vsBisDelta]` lines, string-sanitized; fallback `dpsMetrics.avg - bisAvg` for pre-bisDelta runs.

**Token source display (F5 consumer):** results "Source" column renders `src.category === 'Token'` as `zone.name` + `npc.name (Token)`.

## 5. Resistances panel (fork F8)

New `features/character-stats/` addition: collapsible "Resistances" section in `CharacterStats` below the main table — own table, chevron toggle (default expanded), same tooltip breakdown (base/gear/talents/buffs/consumes/debuffs/bonus/total) and bonus-stats popovers as other stat rows. Data from `statGroups.get('Resistance')`.

## 6. i18n & schema

All user-facing strings land in `assets/locales/en/translation.json` + `schemas/translation.schema.json` (strict). Port the fork's key trees: `upgrade_tab.*` (full tree, ~390 schema lines), `bulk_tab.settings.{optimize_gems,constraints,enchants}`, `bulk_tab.progress.{checking_constraints,optimizing_enchants}`, `bulk_tab.notifications.{no_constraints_met,no_more_enchants}`, reforge `freeze_gem_sockets(+_tooltip)`, `sidebar.character_stats.resistances`, `common.storage_save_failed`. **Must be adapted to the new tree's existing key names** (e.g. `bulk_tab` may now be named differently — check `entity_mapping`/`translation.json` in new tree first).

---

## Commit plan (on top of `upstream/master`)

1. `feat(proto): bulk constraints/enchant opts, frozen gem sockets` — proto + regen.
2. `feat(tools): Wickids BiS list generator and assets`.
3. `feat(db): TBC token gear sources (atlasloot + runtime fallback)`.
4. `feat(reforge): per-socket frozen gem support` — Go backend + UI.
5. `feat(bulk): stat constraints, enchant optimization, optimize-gems toggle`.
6. `feat(upgrades): upgrade finder tab core`.
7. `feat(upgrades): BiS list import, presets, copy enchants`.
8. `feat(upgrades): saved runs, BiS comparison, addon export`.
9. `feat(character-stats): collapsible resistances panel`.

Each commit must pass: `make proto` regen is committed-clean where applicable, `npm run test:locales`, `npx tsc --noEmit` (or the repo's typecheck), `oxlint`, and Go build/tests for backend changes.

## Explicitly dropped

- Fork's client-side LP code (`setupGemLP` etc. in `suggest_reforges_action.tsx`) — superseded by the backend optimizer; only the frozen-socket _semantics_ port (§2).
- `Gear.withoutMetaGem()` — vestigial in the fork (no callers).
- Old `SavedDataManager` enhancements (`setData` name arg, `hasMatchingData`) — superseded by `useSavedData`/`SavedDataPanel`; replicate only behaviors that are still missing (quota surfacing).
- All legacy-tree SCSS — restyle in Tailwind.
- Old per-class spec directories & landing page — superseded by `ui/specs`.
