import { GemSocket } from '@features/gear/components/ItemCell';
import { GemColor } from '@generated/proto/common';
import type { UIGem as Gem } from '@generated/proto/ui';
import i18n from '@i18n/config';
import { usePlayer } from '@sim/context/SimHostContext';
import type { Player } from '@sim/player/player';
import { ActionId } from '@sim/proto/action_id';
import { Stats } from '@sim/proto/stats';
import { FALLBACK_GEM_COLORS } from '@sim/settings/upgrade_settings';
import { Button } from '@ui-kit/Button';
import { Dialog } from '@ui-kit/Dialog';
import { Input } from '@ui-kit/FormControl';
import { useActionId } from '@ui-kit/hooks/useActionId';
import { useState } from 'react';

import { useUpgradeState } from '../../hooks/useUpgradeState';
import { setUpgradeFallbackGem } from '../../model/items';

const formatGemEp = (ep: number) => (ep < 9.95 ? ep.toFixed(1) : Math.round(ep).toString());

interface GemOptionRowProps {
	gem: Gem;
	onPick: (gem: Gem) => void;
}

const GemOptionRow = ({ gem, onPick }: GemOptionRowProps) => {
	const player = usePlayer();
	const { iconUrl, name } = useActionId(ActionId.fromItemId(gem.id));
	return (
		<li className="ui-selector-modal-list-item" data-testid="upgrade-gem-option">
			<button type="button" className="ui-selector-modal-list-item-link w-full text-left" onClick={() => onPick(gem)}>
				<img className="ui-selector-modal-list-item-icon" data-testid="upgrade-gem-option-icon" src={iconUrl || undefined} alt="" />
				<span className="ui-selector-modal-list-item-name">{name ?? gem.name}</span>
			</button>
			<span className="ml-auto pl-2 text-right tabular-nums" data-testid="upgrade-gem-option-ep">
				{formatGemEp(player.computeStatsEP(new Stats(gem.stats)))}
			</span>
		</li>
	);
};

const GemPickerDialog = ({
	player,
	socketColor,
	socketIndex,
	open,
	onOpenChange,
}: {
	player: Player<any>;
	socketColor: GemColor | null;
	socketIndex: number;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) => {
	const [search, setSearch] = useState('');
	const fallbackGemIds = useUpgradeState(slice => slice.fallbackGemIds);
	if (socketColor == null) return null;

	const query = search.toLowerCase().replace(/[^a-z0-9\s]/g, '');
	const gems = player
		.getGems(socketColor)
		// Stats EP keeps the fallback pick useful; a socketable-but-worthless gem floats to the bottom.
		.sort((a, b) => player.computeStatsEP(new Stats(b.stats)) - player.computeStatsEP(new Stats(a.stats)))
		.filter(gem => !query || gem.name.toLowerCase().includes(query));

	const pick = (gem: Gem) => {
		setUpgradeFallbackGem(player, socketIndex, gem.id);
		onOpenChange(false);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={next => {
				if (!next) setSearch('');
				onOpenChange(next);
			}}
			size="lg"
			scrollContents
			title={i18n.t('upgrade_tab.settings.gem_selector_title')}
			testId="upgrade-gem-selector">
			<div className="grid gap-2">
				<Input
					type="text"
					placeholder={i18n.t('common.search')}
					value={search}
					onChange={event => setSearch(event.target.value)}
					data-testid="upgrade-gem-search"
				/>
				{fallbackGemIds[socketIndex] > 0 && (
					<Button
						size="sm"
						variant="secondary"
						data-testid="upgrade-gem-remove"
						onClick={() => {
							setUpgradeFallbackGem(player, socketIndex, 0);
							onOpenChange(false);
						}}>
						{i18n.t('upgrade_tab.settings.remove_gem')}
					</Button>
				)}
				<ul className="list-unstyled mb-0 ps-0">
					{gems.map(gem => (
						<GemOptionRow key={gem.id} gem={gem} onPick={pick} />
					))}
				</ul>
			</div>
		</Dialog>
	);
};

/**
 * One socket color, one fallback gem: candidates sim with the picked gem in every
 * unfrozen empty socket of that color.
 */
export const FallbackGemsPicker = () => {
	const player = usePlayer();
	const fallbackGemIds = useUpgradeState(slice => slice.fallbackGemIds);
	const [openIndex, setOpenIndex] = useState<number | null>(null);

	return (
		<div data-testid="upgrade-fallback-gems">
			<h6 className="mb-2">{i18n.t('upgrade_tab.settings.fallback_gems')}</h6>
			<div className="flex items-center gap-2">
				{FALLBACK_GEM_COLORS.map((socketColor, socketIndex) => {
					const gemId = fallbackGemIds[socketIndex];
					return (
						<GemSocket
							key={socketColor}
							socketColor={socketColor}
							gem={gemId ? player.sim.db.lookupGem(gemId) : null}
							onActivate={() => setOpenIndex(socketIndex)}
							data-testid={`upgrade-fallback-gem-${socketIndex}`}
							role="button"
						/>
					);
				})}
				<GemPickerDialog
					player={player}
					socketColor={openIndex == null ? null : FALLBACK_GEM_COLORS[openIndex]}
					socketIndex={openIndex ?? 0}
					open={openIndex != null}
					onOpenChange={open => !open && setOpenIndex(null)}
				/>
			</div>
		</div>
	);
};
