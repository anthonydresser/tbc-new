import { BulkEnchantSelection } from '@generated/proto/api';
import { ItemSlot, Profession } from '@generated/proto/common';
import type { UIEnchant as Enchant } from '@generated/proto/ui';
import i18n from '@i18n/config';
import { usePlayer } from '@sim/context/SimHostContext';
import type { Player } from '@sim/player/player';
import { ActionId } from '@sim/proto/action_id';
import { canEquipEnchant, enchantAppliesToItem } from '@sim/proto/items';
import { BooleanPicker } from '@ui-kit/BooleanPicker';
import { Button } from '@ui-kit/Button';
import { Chip } from '@ui-kit/Chip';
import { Dialog } from '@ui-kit/Dialog';
import { Input } from '@ui-kit/FormControl';
import { useActionId } from '@ui-kit/hooks/useActionId';
import { toastManager } from '@ui-kit/Toast';
import { useMemo, useState } from 'react';

import { useBulkState } from '../../hooks/useBulkState';
import { setBulkAllowedEnchants, setBulkOptimizeEnchants } from '../../model/settings';

const selectionKey = (selection: BulkEnchantSelection) => `${selection.effectId}-${selection.type}`;
const enchantKey = (enchant: Enchant) => `${enchant.effectId}-${enchant.type}`;

// Eligible = usable by this character (class/profession rules) and applicable to at least one
// equipped item — an enchant that fits nothing equipped can never be picked during a batch.
const eligibleAllowedEnchants = (player: Player<any>): Enchant[] => {
	const hasEnchanting = player.hasProfession(Profession.Enchanting);
	const gear = player.getGear();
	return player.sim.db.getAllEnchants().filter(enchant => {
		if (!canEquipEnchant(enchant, player.getPlayerSpec(), hasEnchanting)) return false;
		return gear.getItemSlots().some((slot: ItemSlot) => {
			const item = gear.getEquippedItem(slot);
			return item != null && enchantAppliesToItem(enchant, item.item);
		});
	});
};

const formatEnchantEp = (ep: number) => (ep < 9.95 ? ep.toFixed(1) : Math.round(ep).toString());

interface EnchantOptionRowProps {
	enchant: Enchant;
	onPick: (enchant: Enchant) => void;
}

const EnchantOptionRow = ({ enchant, onPick }: EnchantOptionRowProps) => {
	const player = usePlayer();
	const actionId = useMemo(() => (enchant.itemId ? ActionId.fromItemId(enchant.itemId) : ActionId.fromSpellId(enchant.spellId)), [enchant]);
	const { iconUrl } = useActionId(actionId);

	return (
		<li className="ui-selector-modal-list-item" data-testid="bulk-enchant-option">
			<button type="button" className="ui-selector-modal-list-item-link w-full text-left" onClick={() => onPick(enchant)}>
				<img className="ui-selector-modal-list-item-icon" data-testid="bulk-enchant-option-icon" src={iconUrl || undefined} alt="" />
				<span className="ui-selector-modal-list-item-name">{enchant.name}</span>
			</button>
			<span className="ml-auto pl-2 text-right tabular-nums" data-testid="bulk-enchant-option-ep">
				{formatEnchantEp(player.computeEnchantEP(enchant))}
			</span>
		</li>
	);
};

export const BulkEnchants = () => {
	const player = usePlayer();
	const optimizeEnchants = useBulkState(slice => slice.optimizeEnchants);
	const allowedEnchants = useBulkState(slice => slice.allowedEnchants);
	const [selectorOpen, setSelectorOpen] = useState(false);
	const [search, setSearch] = useState('');

	const [availableEnchants, setAvailableEnchants] = useState<Enchant[]>([]);
	const openSelector = (): Enchant[] => {
		const selected = new Set(allowedEnchants.map(selectionKey));
		const available = eligibleAllowedEnchants(player).filter(enchant => !selected.has(enchantKey(enchant)));
		setAvailableEnchants(available);
		return available;
	};

	const addEnchant = (enchant: Enchant) => {
		setBulkAllowedEnchants(player, [...allowedEnchants, BulkEnchantSelection.create({ effectId: enchant.effectId, type: enchant.type })]);
		setSelectorOpen(false);
	};

	const query = search.toLowerCase().replace(/[^a-z0-9\s]/g, '');
	const filtered = availableEnchants.filter(enchant => enchant.name.toLowerCase().includes(query));

	return (
		<div className="grid gap-3" data-testid="bulk-enchants">
			<h6 className="mb-0">{i18n.t('bulk_tab.settings.enchants.title')}</h6>
			<div>
				<BooleanPicker
					modObject={player}
					config={{
						id: 'bulk-optimize-enchants',
						label: i18n.t('bulk_tab.settings.enchants.optimize_label'),
						labelTooltip: i18n.t('bulk_tab.settings.enchants.optimize_tooltip'),
						layout: 'inline',
						value: optimizeEnchants,
						onChange: (newValue: boolean) => setBulkOptimizeEnchants(player, newValue),
					}}
				/>
			</div>
			{optimizeEnchants && (
				<>
					<div className="flex flex-wrap items-center gap-2" data-testid="bulk-enchant-allowlist">
						<Button
							size="sm"
							variant="secondary"
							data-testid="bulk-enchant-add"
							onClick={() => {
								const available = openSelector();
								if (!available.length) {
									toastManager.add({ variant: 'warning', body: i18n.t('bulk_tab.notifications.no_more_enchants') });
									return;
								}
								setSearch('');
								setSelectorOpen(true);
							}}>
							{i18n.t('bulk_tab.settings.enchants.add_enchant')}
						</Button>
						{allowedEnchants.map(selection => {
							const enchant = player.sim.db.enchantEffectIdToEnchant(selection.effectId, selection.type);
							return (
								<Chip
									key={selectionKey(selection)}
									label={enchant?.name ?? String(selection.effectId)}
									confirmDelete={false}
									testId="bulk-enchant-chip"
									deleteLabel={i18n.t('bulk_tab.settings.enchants.remove_tooltip')}
									onDelete={() =>
										setBulkAllowedEnchants(
											player,
											allowedEnchants.filter(candidate => selectionKey(candidate) !== selectionKey(selection)),
										)
									}
								/>
							);
						})}
					</div>
					<p className="mb-0 text-sm text-muted">{i18n.t('bulk_tab.settings.enchants.note')}</p>
				</>
			)}
			<Dialog
				open={selectorOpen}
				onOpenChange={open => !open && setSelectorOpen(false)}
				size="lg"
				scrollContents
				title={i18n.t('bulk_tab.settings.enchants.allowlist_label')}
				testId="bulk-enchant-selector">
				<div className="grid gap-2">
					<Input
						type="text"
						placeholder={i18n.t('common.search')}
						value={search}
						onChange={event => setSearch(event.target.value)}
						data-testid="bulk-enchant-search"
					/>
					<ul className="list-unstyled mb-0 ps-0">
						{filtered.map(enchant => (
							<EnchantOptionRow key={enchantKey(enchant)} enchant={enchant} onPick={addEnchant} />
						))}
					</ul>
				</div>
			</Dialog>
		</div>
	);
};
