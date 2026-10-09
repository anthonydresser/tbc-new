// The player-facing half of BiS lists: turning a parsed list into candidates, loading
// a curated preset, and copying the worn gear's enchants onto candidates. Parsing and
// preset fetching live in @sim/upgrade; guards and toasts live here.
import type { ImporterDefinition } from '@features/import-export';
import { ItemSpec } from '@generated/proto/common';
import i18n from '@i18n/config';
import type { Player } from '@sim/player/player';
import { enchantAppliesToItem } from '@sim/proto/items';
import { patchUpgradeState, upgradeState } from '@sim/settings/upgrade_settings';
import { parseBisListJson } from '@sim/upgrade/bis_list_parser';
import { type BisListPresetEntry, loadBisListPreset } from '@sim/upgrade/bis_list_presets';
import { toastManager } from '@ui-kit/Toast';

import { addUpgradeCandidate, isUpgradeRunningGuard, upgradeEligibleSlots } from './items';

// A parse can collect hundreds of per-entry errors; a toast shows the first five and
// a count of the rest. Shared by the import dialog and the preset loader.
export const formatBisListErrors = (errors: ReadonlyArray<{ message: string }>): string => {
	const messages = errors.slice(0, 5).map(e => e.message);
	if (errors.length > 5) {
		messages.push(i18n.t('upgrade_tab.import_bis_list.more_errors', { count: errors.length - 5 }));
	}
	return messages.join('\n');
};

// Entries already in the list, or failing the candidate guards, count as skipped; the
// rest land silently so one toast reports the whole batch.
export const importBisListItems = (player: Player<any>, itemSpecs: ItemSpec[]) => {
	if (isUpgradeRunningGuard(player)) return;
	let added = 0;
	let skipped = 0;
	for (const itemSpec of itemSpecs) {
		if (upgradeState(player).candidates.some(candidate => ItemSpec.equals(candidate.spec, itemSpec))) {
			skipped++;
			continue;
		}
		if (addUpgradeCandidate(player, itemSpec, true)) added++;
		else skipped++;
	}

	if (added > 0 || skipped > 0) {
		toastManager.add({
			delay: 2000,
			variant: skipped > 0 ? 'warning' : 'success',
			body:
				skipped > 0
					? i18n.t('upgrade_tab.import_bis_list.imported_with_skipped', { added, skipped })
					: i18n.t('upgrade_tab.import_bis_list.imported', { count: added }),
		});
	}
};

// The worn enchant of the first slot where the candidate fits and the enchant applies
// is the one to copy. One patch writes every candidate at once so the list re-renders
// once, not per candidate.
export const copyEquippedEnchantsToCandidates = (player: Player<any>) => {
	if (isUpgradeRunningGuard(player)) return;
	const currentGear = player.getGear();
	let applied = 0;
	let skipped = 0;

	const nextCandidates = upgradeState(player).candidates.map(candidate => {
		const copiedEnchant =
			upgradeEligibleSlots(player, candidate)
				.map(slot => currentGear.getEquippedItem(slot)?.enchant ?? null)
				.find(enchant => enchant && enchantAppliesToItem(enchant, candidate.equippedItem.item)) ?? null;
		if (!copiedEnchant) return candidate;
		if (candidate.selectedEnchant?.effectId === copiedEnchant.effectId) {
			skipped++;
			return candidate;
		}
		applied++;
		return { ...candidate, selectedEnchant: copiedEnchant, equippedItem: candidate.equippedItem.withEnchant(copiedEnchant) };
	});

	if (applied > 0) patchUpgradeState(player, { candidates: nextCandidates }, ['settings']);

	if (applied > 0 || skipped > 0) {
		toastManager.add({
			delay: 2000,
			variant: skipped > 0 && applied === 0 ? 'warning' : 'success',
			body: i18n.t('upgrade_tab.notifications.enchants_copied', { applied, skipped }),
		});
	} else {
		toastManager.add({ variant: 'warning', body: i18n.t('upgrade_tab.notifications.enchants_no_match') });
	}
};

export const loadPresetIntoCandidates = async (player: Player<any>, preset: BisListPresetEntry) => {
	try {
		const data = await loadBisListPreset(preset);
		const result = await parseBisListJson(data);
		if (result.itemSpecs.length === 0 && result.errors.length > 0) {
			toastManager.add({ variant: 'error', body: i18n.t('upgrade_tab.presets.load_failed', { label: preset.label }) });
			return;
		}
		importBisListItems(player, result.itemSpecs);
		if (result.errors.length > 0) {
			toastManager.add({
				variant: 'warning',
				body: i18n.t('upgrade_tab.presets.loaded_with_warnings', {
					label: preset.label,
					count: result.errors.length,
					errors: formatBisListErrors(result.errors),
				}),
			});
		}
	} catch (error) {
		toastManager.add({ variant: 'error', body: i18n.t('upgrade_tab.presets.load_failed', { label: preset.label }) });
		console.error('Failed to load preset:', error);
	}
};

export const BIS_LIST_IMPORTER: ImporterDefinition = {
	title: i18n.t('upgrade_tab.import_bis_list.title'),
	allowFileUpload: true,
	onImport: async (host, data) => {
		const result = await parseBisListJson(data);

		if (result.itemSpecs.length === 0 && result.errors.length > 0) {
			throw new Error(formatBisListErrors(result.errors));
		}

		importBisListItems(host.player, result.itemSpecs);

		if (result.errors.length > 0) {
			toastManager.add({
				variant: 'warning',
				delay: 8000,
				body: i18n.t('upgrade_tab.import_bis_list.imported_with_warnings', {
					count: result.itemSpecs.length,
					errors: formatBisListErrors(result.errors),
				}),
			});
		}
	},
};
