// Persisted gem-optimizer settings, extracted from the ReforgeOptimizer
// component (ui/features/reforge/components/ReforgePanel) so the state surface is UI-free.
// TBC has no item reforging: the "reforge" naming is inherited from the MoP port and what the
// optimizer actually chooses is gems and socket bonuses.
// Values live in the sim store (`reforge[player.storeKey]`) with per-field
// version counters; this class is the facade over that slice.
// Serialization lands in IndividualSimSettings.reforgeSettings.
import { GemSocket, ReforgeSettings as ReforgeSettingsProto } from '@generated/proto/api';
import { ItemQuality, ItemSlot, Stat } from '@generated/proto/common';

import { CURRENT_PHASE, Phase } from '../constants/other';
import type { Player } from '../player/player';
import { StatCap, Stats } from '../proto/stats';
import { batch } from '../state/batch';
import { patchKeyed, REFORGE_FIELDS, ReforgeField, ReforgeSlice, seedKeyed, SimStore, zeroVersions } from '../state/sim_store';

// The subset of the per-spec defaults the settings model needs.
export interface ReforgeSettingsDefaults {
	statCaps?: Stats;
	softCapBreakpoints?: StatCap[];
	breakpointLimits?: Stats;
}

export class ReforgeSettings {
	private readonly player: Player<any>;
	private readonly defaults: ReforgeSettingsDefaults;
	// The stats this spec is willing to gem for. A gem is only a candidate if every stat it carries
	// is in this list, so specs list stats they weight at 0 (Stamina, spell penetration) to keep
	// those gems selectable. It cannot be derived from the pre-cap EPs for exactly that reason.
	private readonly epStats: ReadonlyArray<Stat>;
	readonly store: SimStore;
	readonly storeKey: number;

	constructor(player: Player<any>, defaults: ReforgeSettingsDefaults, epStats: ReadonlyArray<Stat> = []) {
		this.player = player;
		this.defaults = defaults;
		this.epStats = epStats;
		this.store = player.sim.store;
		this.storeKey = player.storeKey;

		// Seed the slice (emit-less, like the old field initializers).
		seedKeyed(this.store, 'reforge', this.storeKey, {
			statCaps: defaults.statCaps || new Stats(),
			breakpointLimits: new Stats(),
			useCustomEPValues: false,
			useSoftCapBreakpoints: true,
			softCapBreakpoints: [],
			freezeItemSlots: false,
			frozenItemSlots: [],
			frozenGemSockets: [],
			maxGemPhase: CURRENT_PHASE,
			maxGemQuality: ItemQuality.ItemQualityEpic,
			disableUniqueGems: false,
			undershootCaps: new Stats(),
			v: zeroVersions(REFORGE_FIELDS),
		});
	}

	private get slice(): ReforgeSlice {
		return this.store.getState().reforge[this.storeKey];
	}

	// Writes `patch` and bumps the given counters in one store write. No bumps
	// = the old silent field assignment.
	private write(patch: Partial<Omit<ReforgeSlice, 'v'>>, bumps: ReadonlyArray<ReforgeField> = []) {
		patchKeyed(this.store, 'reforge', this.storeKey, patch, bumps);
	}

	// ---- field accessors (property-style, as before)
	get _statCaps(): Stats {
		return this.slice.statCaps;
	}
	get breakpointLimits(): Stats {
		return this.slice.breakpointLimits;
	}
	get useCustomEPValues(): boolean {
		return this.slice.useCustomEPValues;
	}
	get useSoftCapBreakpoints(): boolean {
		return this.slice.useSoftCapBreakpoints;
	}
	get softCapBreakpoints(): StatCap[] {
		return this.slice.softCapBreakpoints;
	}
	get freezeItemSlots(): boolean {
		return this.slice.freezeItemSlots;
	}
	// Snapshot view; mutate through setFrozenItemSlot(s).
	get frozenItemSlots(): Set<ItemSlot> {
		return new Set(this.slice.frozenItemSlots as ItemSlot[]);
	}
	get undershootCaps(): Stats {
		return this.slice.undershootCaps;
	}
	// Silent assignment (no emit), matching the old direct field write.
	set undershootCaps(value: Stats) {
		this.write({ undershootCaps: value });
	}
	get disableUniqueGems(): boolean {
		return this.slice.disableUniqueGems;
	}

	setStatCaps(newStatCaps: Stats) {
		this.write({ statCaps: newStatCaps }, ['statCaps']);
	}

	get statCaps() {
		return this.useCustomEPValues ? this._statCaps : this.defaults.statCaps || new Stats();
	}

	setUseCustomEPValues(newUseCustomEPValues: boolean) {
		if (newUseCustomEPValues !== this.useCustomEPValues) {
			this.write({ useCustomEPValues: newUseCustomEPValues }, ['useCustomEPValues']);
		}
	}

	setUseSoftCapBreakpoints(newUseSoftCapBreakpoints: boolean) {
		if (newUseSoftCapBreakpoints !== this.useSoftCapBreakpoints) {
			this.write({ useSoftCapBreakpoints: newUseSoftCapBreakpoints }, ['useSoftCapBreakpoints']);
		}
	}

	setBreakpointLimits(newLimits: Stats) {
		this.write({ breakpointLimits: newLimits }, ['breakpointLimits']);
	}

	setSoftCapBreakpoints(newSoftCapBreakpoints: StatCap[]) {
		this.write({ softCapBreakpoints: newSoftCapBreakpoints }, ['softCapBreakpoints']);
	}

	setFreezeItemSlots(newValue: boolean) {
		if (this.freezeItemSlots !== newValue) {
			this.write({ frozenItemSlots: [], freezeItemSlots: newValue }, ['freezeItemSlots']);
		}
	}

	setFrozenItemSlot(slot: ItemSlot, frozen: boolean) {
		if (this.getFrozenItemSlot(slot) !== frozen) {
			const next = new Set(this.slice.frozenItemSlots as ItemSlot[]);
			next[frozen ? 'add' : 'delete'](slot);
			this.write({ frozenItemSlots: [...next] }, ['freezeItemSlots']);
		}
	}

	// Sets all frozen item slots at once
	setFrozenItemSlots(slots: ItemSlot[]) {
		this.write({ frozenItemSlots: [...new Set(slots)] }, ['freezeItemSlots']);
	}

	getFrozenItemSlot(slot: ItemSlot): boolean {
		return (this.slice.frozenItemSlots as ItemSlot[]).includes(slot);
	}

	// ---- individually frozen gem sockets, keyed `${slot}_${socketIdx}` (mirrors SocketBonusKey
	// conventions elsewhere). Frozen sockets keep their socketed gem through optimization and
	// through bulk/upgrade fallback gemming.
	static frozenGemSocketKey(slot: ItemSlot, socketIdx: number): string {
		return `${slot}_${socketIdx}`;
	}

	setFrozenGemSocket(slot: ItemSlot, socketIdx: number, frozen: boolean) {
		const key = ReforgeSettings.frozenGemSocketKey(slot, socketIdx);
		const next = new Set(this.slice.frozenGemSockets);
		if (frozen === next.has(key)) {
			return;
		}
		next[frozen ? 'add' : 'delete'](key);
		this.write({ frozenGemSockets: [...next] }, ['frozenGemSockets']);
	}

	setFrozenGemSockets(sockets: Array<{ slot: ItemSlot; socketIdx: number }>) {
		this.write({ frozenGemSockets: sockets.map(({ slot, socketIdx }) => ReforgeSettings.frozenGemSocketKey(slot, socketIdx)) }, ['frozenGemSockets']);
	}

	getFrozenGemSocket(slot: ItemSlot, socketIdx: number): boolean {
		return this.slice.frozenGemSockets.includes(ReforgeSettings.frozenGemSocketKey(slot, socketIdx));
	}

	getFrozenGemSockets(): Set<string> {
		return new Set(this.slice.frozenGemSockets);
	}

	// ---- the gem pool knobs. TBC-only: MoP's reforger has no counterpart for any of them.
	setMaxGemPhase(phase: number) {
		this.write({ maxGemPhase: phase }, ['maxGemPhase']);
	}

	getMaxGemPhase(): number {
		return this.slice.maxGemPhase;
	}

	setMaxGemQuality(quality: ItemQuality) {
		this.write({ maxGemQuality: quality }, ['maxGemQuality']);
	}

	getMaxGemQuality(): ItemQuality {
		return this.slice.maxGemQuality;
	}

	setDisableUniqueGems(disableUniqueGems: boolean) {
		this.write({ disableUniqueGems }, ['disableUniqueGems']);
	}

	// A preset build carries a *partial* ReforgeSettings — vanilla's type was literally
	// `Partial<ReforgeSettings>` — so each field is applied only when the preset actually
	// sets it, and anything it leaves out keeps the value `applyDefaults()` gave it.
	// `fromProto` is the deserialization path and replaces every field, which resets the
	// spec's soft-cap breakpoints, stat caps and frozen slots to proto zero values.
	//
	// The field list is vanilla's: `maxGemQuality` and `disableUniqueGems` are deliberately
	// absent, because vanilla never read them out of a build either. Mage's P3 preset sets
	// `disableUniqueGems: true` and it has never had an effect.
	applyPreset(proto: ReforgeSettingsProto) {
		batch(() => {
			if (proto.useCustomEpValues) this.setUseCustomEPValues(proto.useCustomEpValues);
			if (proto.statCaps) this.setStatCaps(Stats.fromProto(proto.statCaps));
			if (proto.useSoftCapBreakpoints) this.setUseSoftCapBreakpoints(proto.useSoftCapBreakpoints);
			if (proto.freezeItemSlots) this.setFreezeItemSlots(proto.freezeItemSlots);
			// `.length`, not truthiness. Vanilla's presets were plain `Partial<ReforgeSettings>`
			// literals where an unset repeated field is `undefined`; these are real protos, and
			// protobuf-ts `create()` seeds every repeated field to `[]`, which is truthy — so a bare
			// guard here empties the slots a user pinned in the optimizer on every preset click.
			if (proto.frozenItemSlots.length) this.setFrozenItemSlots(proto.frozenItemSlots);
			if (proto.frozenGemSockets.length) this.setFrozenGemSockets(proto.frozenGemSockets.map(s => ({ slot: s.slot, socketIdx: s.socketIdx })));
			if (proto.breakpointLimits) this.setBreakpointLimits(Stats.fromProto(proto.breakpointLimits));
			if (proto.maxGemPhase) this.setMaxGemPhase(proto.maxGemPhase);
		});
	}

	fromProto(proto: ReforgeSettingsProto) {
		batch(() => {
			this.setUseCustomEPValues(proto.useCustomEpValues);
			this.setStatCaps(Stats.fromProto(proto.statCaps));
			this.setUseSoftCapBreakpoints(proto.useSoftCapBreakpoints);
			this.setFreezeItemSlots(proto.freezeItemSlots);
			this.setFrozenItemSlots(proto.frozenItemSlots);
			this.setFrozenGemSockets(proto.frozenGemSockets.map(s => ({ slot: s.slot, socketIdx: s.socketIdx })));
			this.setBreakpointLimits(Stats.fromProto(proto.breakpointLimits));
			this.setDisableUniqueGems(proto.disableUniqueGems);
			this.setMaxGemPhase(proto.maxGemPhase || Phase.Phase1);
			this.setMaxGemQuality(proto.maxGemQuality || ItemQuality.ItemQualityEpic);
		});
	}

	toProto(): ReforgeSettingsProto {
		return ReforgeSettingsProto.create({
			useCustomEpValues: this.useCustomEPValues,
			useSoftCapBreakpoints: this.useSoftCapBreakpoints,
			freezeItemSlots: this.freezeItemSlots,
			frozenItemSlots: [...this.frozenItemSlots],
			frozenGemSockets: [...this.getFrozenGemSockets()].map(key => {
				const [slot, socketIdx] = key.split('_');
				return GemSocket.create({ slot: Number(slot) as ItemSlot, socketIdx: Number(socketIdx) });
			}),
			breakpointLimits: this.breakpointLimits.toProto(),
			statCaps: this.statCaps.toProto(),
			disableUniqueGems: this.disableUniqueGems,
			maxGemPhase: this.getMaxGemPhase(),
			maxGemQuality: this.getMaxGemQuality(),
			epStats: [...this.epStats],
		});
	}

	applyDefaults() {
		batch(() => {
			this.setUseCustomEPValues(false);
			this.setUseSoftCapBreakpoints(!!this.defaults.softCapBreakpoints?.length);
			this.setFreezeItemSlots(false);
			this.setFrozenGemSockets([]);
			this.setStatCaps(this.defaults.statCaps || new Stats());
			this.setBreakpointLimits(this.defaults.breakpointLimits || new Stats());
			this.setSoftCapBreakpoints(this.defaults.softCapBreakpoints || []);
			this.setDisableUniqueGems(false);
			this.setMaxGemPhase(this.player.sim.getPhase());
			this.setMaxGemQuality(ItemQuality.ItemQualityEpic);
		});
	}
}
