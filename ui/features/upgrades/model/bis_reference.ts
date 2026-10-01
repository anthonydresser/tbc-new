// The BiS reference set the finder optionally compares every candidate against: one
// of the spec's authored preset gear sets, or a gear set saved in the gear tab.
// Both resolve by the label the dropdown shows — the user's stored pick survives a
// rename only when nothing matches anymore, and the run warns rather than failing.
import { SavedGearSet } from '@generated/proto/ui';
import i18n from '@i18n/config';
import type { PresetGear } from '@sim/presets/types';
import type { Gear } from '@sim/proto/gear';
import { upgradeState } from '@sim/settings/upgrade_settings';
import type { IndividualSimHost } from '@sim/sim_host';

export type BisReferenceOption = { kind: 'preset'; label: string; preset: PresetGear } | { kind: 'saved'; name: string };

// Saved gear sets live only in the env storage under the gear tab's saved-data slot
// (Record<name, SavedGearSet json>); there is no other accessor. Skips entries the
// codec rejects, the way every saved-data reader does.
export const getSavedGearSets = (host: IndividualSimHost<any>): Array<{ name: string; data: SavedGearSet }> => {
	let dataStr: string | null;
	try {
		dataStr = host.sim.env.storage.getItem(host.getSavedGearStorageKey());
	} catch {
		return [];
	}
	if (!dataStr) return [];

	let jsonData: Record<string, any>;
	try {
		jsonData = JSON.parse(dataStr);
	} catch {
		console.warn('Failed to parse saved gear sets for the BiS reference picker.');
		return [];
	}

	const sets: Array<{ name: string; data: SavedGearSet }> = [];
	for (const name in jsonData) {
		try {
			sets.push({ name, data: SavedGearSet.fromJson(jsonData[name]) });
		} catch {
			console.warn('Failed parsing saved gear set for the BiS reference picker: ', name);
		}
	}
	return sets;
};

// Preset gear sets can share a name (e.g. warrior 'BIS' sets per phase/group, which
// the gear tab separates via phase tabs and group headings), so the dropdown needs
// unique labels: duplicated names are qualified with their group/phase. The label is
// what gets stored in saved runs, so resolving by the same computed label round-trips.
export const getPresetGearOptions = (host: IndividualSimHost<any>): Array<{ label: string; preset: PresetGear }> => {
	const presets = host.individualConfig.presets.gear;
	const nameCounts = new Map<string, number>();
	presets.forEach(preset => nameCounts.set(preset.name, (nameCounts.get(preset.name) ?? 0) + 1));

	const usedLabels = new Set<string>();
	return presets.map(preset => {
		let label = preset.name;
		if ((nameCounts.get(preset.name) ?? 0) > 1) {
			const qualifiers: string[] = [];
			if (preset.group) qualifiers.push(preset.group);
			if (preset.phase !== undefined && preset.phase > 0) qualifiers.push(i18n.t(`common.phase_names.${preset.phase}`));
			if (qualifiers.length) label = `${preset.name} (${qualifiers.join(', ')})`;
			// Identical name+group+phase is still possible; number them.
			let suffix = 2;
			while (usedLabels.has(label)) label = `${label.replace(/ #\d+$/, '')} #${suffix++}`;
		}
		usedLabels.add(label);
		return { label, preset };
	});
};

export const getBisReferenceOptions = (host: IndividualSimHost<any>): Array<BisReferenceOption> => [
	...getPresetGearOptions(host).map(({ label, preset }): BisReferenceOption => ({ kind: 'preset', label, preset })),
	...getSavedGearSets(host).map(({ name }): BisReferenceOption => ({ kind: 'saved', name })),
];

// The reference set is simmed exactly as saved (its own items/enchants/gems).
// SavedGearSet.bonusStatsStats is intentionally ignored: bonus stats belong to the
// player's other settings, and the baseline sim uses the current player's too.
export const resolveBisReferenceGear = (host: IndividualSimHost<any>): Gear | null => {
	const { bisReferenceName, bisReferenceIsPreset } = upgradeState(host.player);
	if (!bisReferenceName) return null;

	const resolvePreset = (): Gear | null => {
		const preset =
			getPresetGearOptions(host).find(option => option.label === bisReferenceName)?.preset ??
			// Runs saved before presets had unique labels stored the bare name.
			host.individualConfig.presets.gear.find(presetGear => presetGear.name === bisReferenceName);
		return preset ? host.sim.db.lookupEquipmentSpec(preset.gear) : null;
	};
	const resolveSaved = (): Gear | null => {
		const saved = getSavedGearSets(host).find(savedSet => savedSet.name === bisReferenceName);
		return saved?.data.gear ? host.sim.db.lookupEquipmentSpec(saved.data.gear) : null;
	};

	// Fall back to the other source in case the set was re-saved under a different kind.
	return (bisReferenceIsPreset ? resolvePreset() : resolveSaved()) ?? (bisReferenceIsPreset ? resolveSaved() : resolvePreset());
};
