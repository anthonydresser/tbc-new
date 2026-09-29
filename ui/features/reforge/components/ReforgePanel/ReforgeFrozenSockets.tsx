import i18n from '@i18n/config';
import { translateSlotName } from '@i18n/localization';
import type { Player } from '@sim/player/player';
import { getEmptyGemSocketIconUrl } from '@sim/proto/gems';
import type { ReforgeSettings } from '@sim/settings/reforge_settings';
import { Button } from '@ui-kit/Button';
import { Icon } from '@ui-kit/Icon';
import { Tooltip, tooltipAnchorProps } from '@ui-kit/Tooltip';
import { useId, useMemo } from 'react';

import { useReforgeField } from '../../hooks/useReforgeField';
import { useReforgeIdPrefix } from './ReforgeIdPrefixContext';

export interface ReforgeFrozenSocketsProps {
	settings: ReforgeSettings;
	player: Player<any>;
}

/** One clickable socket icon per socket of each equipped item; clicking freezes that socket's current gem against gem optimization. */
export const ReforgeFrozenSockets = ({ settings, player }: ReforgeFrozenSocketsProps) => {
	const tooltipId = useId();
	const idPrefix = useReforgeIdPrefix();
	// The frozen set itself is read per socket below; subscribing bumps a re-render when any of them flips.
	useReforgeField(settings, 'frozenGemSockets', () => settings.getFrozenGemSockets().size);

	// Slots with sockets depend on the equipped gear. The popover mount rebuilds this per open (as
	// ReforgeFrozenSlots does), so a gear read memoised on the player is never stale there.
	const socketRows = useMemo(() => {
		const gear = player.getGear();
		return gear
			.getItemSlots()
			.map(slot => ({ slot, item: gear.getEquippedItem(slot) }))
			.filter(({ item }) => (item?.numSockets() ?? 0) > 0);
	}, [player]);

	if (!socketRows.length) return null;

	return (
		<div className="mb-2">
			<div className="flex">
				<h6 className="mr-1 mb-0">{i18n.t('sidebar.buttons.suggest_reforges.freeze_gem_sockets')}</h6>
				<Button variant="unstyled" className="inline" {...tooltipAnchorProps(tooltipId)}>
					<Icon name="circle-question" style="regular" />
				</Button>
				<Tooltip id={tooltipId} content={i18n.t('sidebar.buttons.suggest_reforges.freeze_gem_sockets_tooltip')} />
			</div>
			<table className="w-full border-collapse">
				<tbody>
					{socketRows.map(({ slot, item }) => (
						<tr key={slot}>
							<td className="w-0 pr-2 pb-1 whitespace-nowrap">{translateSlotName(slot)}</td>
							<td className="pb-1">
								<div className="flex items-center gap-1">
									{item!.curSocketColors().map((socketColor, socketIdx) => {
										const frozen = settings.getFrozenGemSocket(slot, socketIdx);
										return (
											<button
												key={socketIdx}
												type="button"
												id={`${idPrefix}-freeze-gem-${slot}-${socketIdx}`}
												className="relative size-(--gem-width) shrink-0 cursor-pointer bg-contain bg-no-repeat"
												style={{ backgroundImage: `url(${getEmptyGemSocketIconUrl(socketColor)})` }}
												aria-pressed={frozen}
												onClick={() => settings.setFrozenGemSocket(slot, socketIdx, !frozen)}>
												{frozen && (
													<>
														<span className="absolute inset-0 rounded-full bg-black/50" />
														<Icon
															name="lock"
															className="absolute inset-0 flex items-center justify-center text-[calc(var(--gem-width)/2)] text-warning"
														/>
													</>
												)}
											</button>
										);
									})}
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
};
