import { ItemSlot, PseudoStat, Spec } from '@generated/proto/common';
import i18n from '@i18n/config';
import { useSimHost, useSpecConfig } from '@sim/context/SimHostContext';
import { usePlayerStore } from '@sim/hooks/usePlayerStore';
import { computeStatAttribution, type Stats, type UnitStat } from '@sim/proto/stats';
import { Icon } from '@ui-kit/Icon';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';

import { AvoidanceRow } from './AvoidanceRow';
import { CritCapRow } from './CritCapRow';
import { CritImmunityRow } from './CritImmunityRow';
import { MissRow } from './MissRow';
import { StatRow } from './StatRow';
import { buildRows, type RowGroup } from './utils/rows';
import {
	critImmunityCapDisplayString,
	meleeCritCapDisplayString,
	readRacialBonuses,
	shouldShowCritImmunity,
	shouldShowMeleeCritCap,
	statDisplayString,
} from './utils/stat_display';

export const CharacterStats = () => {
	const host = useSimHost();
	const player = host.player;
	const { displayStats, modifyDisplayStats, overwriteDisplayStats } = useSpecConfig();
	const { groups, shownStats } = useMemo(() => buildRows(player, displayStats), [player, displayStats]);

	const currentStats = usePlayerStore('currentStats');
	const bonusStats = usePlayerStore('bonusStats');
	const gear = usePlayerStore('gear');
	const race = usePlayerStore('race');
	const consumables = usePlayerStore('consumables');
	const talentsString = usePlayerStore('talentsString');
	const inFrontOfTarget = usePlayerStore('inFrontOfTarget');
	// Not player state, but read by the facade getters below: getDebuffStats and getMissChanceInfo
	// go through raid.debuffs, getRangedImbueStatOffsets through the party's windfury totem, and
	// getMeleeCritCapInfo through the primary target's level.
	const debuffs = useStore(host.sim.store, s => s.raid.debuffs);
	const partyBuffs = useStore(host.sim.store, s => s.raid.partyBuffs);
	const targets = useStore(host.sim.store, s => s.encounter.targets);

	const snapshot = useMemo(() => {
		const racial = readRacialBonuses(player);
		const attribution = computeStatAttribution(
			player.getCurrentStats(),
			bonusStats,
			player.getDebuffStats(),
			modifyDisplayStats ? modifyDisplayStats(player) : {},
			overwriteDisplayStats ? overwriteDisplayStats(player) : undefined,
		);
		const isTank = shouldShowCritImmunity(player);
		return {
			pending: !currentStats.finalStats,
			racial,
			attribution,
			rangedWeapon: player.getEquippedItem(ItemSlot.ItemSlotRanged),
			critCap: shouldShowMeleeCritCap(player) ? { info: player.getMeleeCritCapInfo(), text: meleeCritCapDisplayString(player) } : null,
			miss: isTank ? player.getMissChanceInfo() : null,
			avoidance: isTank ? player.getAvoidanceInfo() : null,
			critImmunity: isTank ? { info: player.getCritImmunityInfo(), text: critImmunityCapDisplayString(player) } : null,
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- every store value below reaches the body through the player/sim facades rather than by name; they are the invalidation keys, and dropping one stales the snapshot.
	}, [
		player,
		currentStats,
		bonusStats,
		gear,
		race,
		consumables,
		talentsString,
		inFrontOfTarget,
		debuffs,
		partyBuffs,
		targets,
		modifyDisplayStats,
		overwriteDisplayStats,
	]);

	const { pending, racial, attribution, rangedWeapon, critCap, miss, avoidance, critImmunity } = snapshot;
	const show = (deltaStats: Stats, unitStat: UnitStat, includeBase?: boolean, includeGear?: boolean, includeConsumes?: boolean) =>
		statDisplayString(player, racial, deltaStats, unitStat, includeBase, includeGear, includeConsumes);

	const hasParry = shownStats.some(stat => stat.equalsPseudoStat(PseudoStat.PseudoStatParryPercent));
	const hasBlock = shownStats.some(stat => stat.equalsPseudoStat(PseudoStat.PseudoStatBlockPercent));

	// Resistances get their own collapsible table below the main one (TBC's resistance fight
	// gear makes those five rows noisy enough to want them hideable).
	const [resistancesExpanded, setResistancesExpanded] = useState(true);
	// MeleeCritCap is appended after Resistance, so it rejoins the main table here.
	const mainGroups = groups.filter(group => group.key !== 'Resistance');
	const resistanceGroup = groups.find(group => group.key === 'Resistance');

	const renderGroup = (group: RowGroup) => (
		<tbody key={group.key}>
			{group.rows.map(row => {
				switch (row.kind) {
					case 'stat':
						return (
							<StatRow
								key={row.id}
								displayStat={row.displayStat}
								bonusStats={bonusStats}
								attribution={attribution}
								show={show}
								rangedWeapon={rangedWeapon}
								pending={pending}
							/>
						);
					case 'miss':
						return miss && <MissRow key={row.id} info={miss} pending={pending} />;
					case 'avoidance':
						return (
							avoidance && (
								<AvoidanceRow
									key={row.id}
									info={avoidance}
									withHolyShield={player.isSpec(Spec.SpecProtectionPaladin)}
									hasParry={hasParry}
									hasBlock={hasBlock}
									pending={pending}
								/>
							)
						);
					case 'crit-immunity':
						return critImmunity && <CritImmunityRow key={row.id} info={critImmunity.info} text={critImmunity.text} pending={pending} />;
					case 'melee-crit-cap':
						return critCap && <CritCapRow key={row.id} info={critCap.info} text={critCap.text} pending={pending} />;
				}
			})}
		</tbody>
	);

	return (
		<div data-testid="character-stats-root" className="w-full">
			<h3 data-testid="character-stats-label" className="m-0 mb-2 inline-block text-base leading-tight font-bold">
				{i18n.t('sidebar.character_stats.title')}
			</h3>
			<table className="w-full p-2.5" aria-busy={pending || undefined}>
				{mainGroups.map(renderGroup)}
			</table>
			{resistanceGroup && (
				<table className="w-full p-2.5" data-testid="character-stats-resistance-table" aria-busy={pending || undefined}>
					<thead>
						<tr>
							<th colSpan={2} className="text-left">
								<button
									type="button"
									className="flex w-full items-center gap-1 text-sm font-bold"
									data-testid="character-stats-resistance-toggle"
									aria-expanded={resistancesExpanded}
									onClick={() => setResistancesExpanded(expanded => !expanded)}>
									<Icon name="chevron-down" className={clsx('transition-transform', !resistancesExpanded && '-rotate-90')} />
									<span>{i18n.t('sidebar.character_stats.resistances')}</span>
								</button>
							</th>
						</tr>
					</thead>
					{resistancesExpanded && renderGroup(resistanceGroup)}
				</table>
			)}
		</div>
	);
};
