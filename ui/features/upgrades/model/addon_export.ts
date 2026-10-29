// The WoWSimsUpgradeList addon import string: a versioned header plus one line per
// displayed result row.
//
//	WWSULv2|<listName>|<specFriendlyName>|<unixTimestamp>|<baselineDps>
//	<slot>:<itemId>:<enchantName>:<gemId1>,<gemId2>,...:<delta>
//
// When the run included a BiS reference set the version bumps to v3 (old addon
// versions reject it rather than misparsing the extra field):
//
//	WWSULv3|<listName>|<specFriendlyName>|<unixTimestamp>|<baselineDps>|<bisDps>
//	<slot>:<itemId>:<enchantName>:<gemId1>,<gemId2>,...:<delta>:<vsBisDelta>
//
// When any displayed result is an owned item the version bumps to v4 and every row
// carries a trailing owned flag (0/1); with no BiS run the vs-BiS field goes out
// empty so the flag keeps its position:
//
//	WWSULv4|...                       (header shape follows the v2/v3 rule above)
//	<slot>:<itemId>:<enchantName>:<gemIds>:<delta>:<vsBisDelta|>:<0|1>
//
// When any displayed result drops in a zone the version bumps to v5 and every row
// carries a trailing comma list of drop-zone ids (empty for non-drop items, e.g.
// crafted or badge gear); the addon uses them for its "current zone only" filter:
//
//	WWSULv5|...                       (header shape follows the v2/v3 rule above)
//	<slot>:<itemId>:<enchantName>:<gemIds>:<delta>:<vsBisDelta|>:<0|1>:<zoneId,...|>
//
// Only visible rows export: anything hidden by the owned or non-upgrades filters,
// and the equipped-identity marker rows (which were never simmed), are excluded.
import type { ExporterDefinition } from '@features/import-export';
import i18n from '@i18n/config';
import { inventoryItems } from '@sim/settings/inventory_settings';
import { upgradeState } from '@sim/settings/upgrade_settings';

import { getDisplayedUpgradeResults, getVisibleUpgradeResults } from './items';

// Field delimiters and line breaks cannot come from item or enchant names.
const sanitize = (s: string) => s.replace(/[|:\r\n]/g, ' ').trim();

export const UPGRADE_ADDON_EXPORTER: ExporterDefinition = {
	title: i18n.t('upgrade_tab.results.export_addon_title'),
	getData: host => {
		const state = upgradeState(host.player);
		if (!state.results || !state.baseline) return '';

		const specName = sanitize(host.player.getPlayerSpec().friendlyName);
		const listName = sanitize(`${specName} Upgrades`);
		const timestamp = Math.floor(Date.now() / 1000);
		const bisDps = state.bisResult?.dpsMetrics.avg ?? null;

		// The export mirrors the results table: rows hidden by the owned/non-upgrades
		// filters stay out of the string, as do equipped-identity marker rows (no sim
		// ran for them, so there is nothing meaningful to show in-game).
		const ownedIds = new Set(inventoryItems(host.player).map(spec => spec.id));
		const displayed = getVisibleUpgradeResults(
			getDisplayedUpgradeResults(state.results).filter(result => !result.equippedAlready),
			ownedIds,
			state.hideOwnedResults,
			state.hideNonUpgrades,
		);
		// The zone list bumps the format so the addon's current-zone filter can
		// trust trailing positions: in v5, the vs-BiS and owned fields always get
		// emitted (empty when absent) so zones stay last.
		const zoneIdsOf = (result: (typeof displayed)[number]): Array<number> => {
			const ids = new Set<number>();
			for (const source of result.item.item.sources ?? []) {
				if (source.source.oneofKind === 'drop' && source.source.drop.zoneId > 0) ids.add(source.source.drop.zoneId);
			}
			return [...ids];
		};
		const hasZones = displayed.some(result => zoneIdsOf(result).length > 0);
		const hasOwned = displayed.some(result => ownedIds.has(result.item.item.id));
		// v5 implies the owned and vs-BiS fields always exist, even if all-0/empty.
		const version = hasZones ? 5 : hasOwned ? 4 : bisDps == null ? 2 : 3;

		const header =
			bisDps == null
				? `WWSULv${version}|${listName}|${specName}|${timestamp}|${state.baseline.dpsMetrics.avg.toFixed(1)}`
				: `WWSULv${version}|${listName}|${specName}|${timestamp}|${state.baseline.dpsMetrics.avg.toFixed(1)}|${bisDps.toFixed(1)}`;

		const lines = displayed.map(result => {
			// The enchant goes out as its display name: effectId is sim-internal and
			// useless in-game.
			const enchantName = sanitize(result.item.enchant?.name ?? '');
			const gemIds = result.item.gems
				.filter(gem => gem != null && gem.id > 0)
				.map(gem => gem!.id)
				.join(',');
			const line = `${result.slot}:${result.item.item.id}:${enchantName}:${gemIds}:${result.delta.toFixed(1)}`;
			// Runs from before the per-candidate reference sim have no bisDelta; fall
			// back to the absolute difference for the export. The field stays present
			// (empty) in v4-without-bis so the owned flag keeps its position.
			const bisField = bisDps == null ? (version >= 4 ? '' : null) : (result.bisDelta ?? result.dpsMetrics.avg - bisDps).toFixed(1);
			const ownedField = version >= 4 ? (ownedIds.has(result.item.item.id) ? '1' : '0') : null;
			const zonesField = version >= 5 ? zoneIdsOf(result).join(',') : null;
			return [line, bisField, ownedField, zonesField].filter(part => part != null).join(':');
		});
		return [header, ...lines].join('\n');
	},
};
