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
import type { ExporterDefinition } from '@features/import-export';
import i18n from '@i18n/config';
import { upgradeState } from '@sim/settings/upgrade_settings';

import { getDisplayedUpgradeResults } from './items';

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

		const header =
			bisDps == null
				? `WWSULv2|${listName}|${specName}|${timestamp}|${state.baseline.dpsMetrics.avg.toFixed(1)}`
				: `WWSULv3|${listName}|${specName}|${timestamp}|${state.baseline.dpsMetrics.avg.toFixed(1)}|${bisDps.toFixed(1)}`;

		const lines = getDisplayedUpgradeResults(state.results).map(result => {
			// The enchant goes out as its display name: effectId is sim-internal and
			// useless in-game.
			const enchantName = sanitize(result.item.enchant?.name ?? '');
			const gemIds = result.item.gems
				.filter(gem => gem != null && gem.id > 0)
				.map(gem => gem!.id)
				.join(',');
			const line = `${result.slot}:${result.item.item.id}:${enchantName}:${gemIds}:${result.delta.toFixed(1)}`;
			if (bisDps == null) return line;
			// Runs from before the per-candidate reference sim have no bisDelta; fall
			// back to the absolute difference for the export.
			return `${line}:${(result.bisDelta ?? result.dpsMetrics.avg - bisDps).toFixed(1)}`;
		});
		return [header, ...lines].join('\n');
	},
};
