import { ItemDetailCell } from '@features/gear/components/ItemCell';
import { useOpenSelectorModal } from '@features/gear/hooks/useSelectorModal';
import { SelectorModalTabs } from '@features/gear/types';
import i18n from '@i18n/config';
import { translateSlotName } from '@i18n/localization';
import { usePlayer } from '@sim/context/SimHostContext';
import { Button } from '@ui-kit/Button';
import { Icon } from '@ui-kit/Icon';

import { useUpgradeState } from '../../hooks/useUpgradeState';
import { createUpgradeCandidateGearData } from '../../model/gear_data';
import { removeUpgradeCandidate, upgradeEligibleSlots } from '../../model/items';

/**
 * The authored candidate rows: the item as the gear vocabulary renders it, the slots
 * it can be simmed in, its enchant override, and a remove control. Enchanting opens
 * the shared selector modal with a candidate-scoped gear data seam.
 */
export const UpgradeCandidateList = () => {
	const player = usePlayer();
	const openSelectorModal = useOpenSelectorModal();
	const candidates = useUpgradeState(slice => slice.candidates);

	if (!candidates.length) {
		return <div data-testid="upgrade-no-items">{i18n.t('upgrade_tab.picker.no_items')}</div>;
	}

	return (
		<div className="grid gap-2" data-testid="upgrade-candidate-list">
			{candidates.map((candidate, index) => {
				const slots = upgradeEligibleSlots(player, candidate);
				const slot = slots[0];
				const slotsLabel = slots.map(eligibleSlot => translateSlotName(eligibleSlot)).join(', ');
				return (
					<div className="flex items-center gap-2" data-testid="upgrade-candidate-row" key={`${candidate.spec.id}-${index}`}>
						<ItemDetailCell
							slot={slot}
							item={candidate.selectedEnchant ? candidate.equippedItem.withEnchant(candidate.selectedEnchant) : candidate.equippedItem}
							className="flex-1"
							extraLabels={<small data-testid="upgrade-candidate-slots">{slotsLabel}</small>}
						/>
						<Button
							size="sm"
							variant="secondary"
							data-testid="upgrade-candidate-enchant-btn"
							onClick={() => openSelectorModal(slot, SelectorModalTabs.Enchants, createUpgradeCandidateGearData(player, index))}>
							{candidate.selectedEnchant ? candidate.selectedEnchant.name : i18n.t('upgrade_tab.picker.add_enchant')}
						</Button>
						<Button
							iconOnly
							variant="link-danger"
							title={i18n.t('upgrade_tab.results.remove_tooltip')}
							aria-label={i18n.t('upgrade_tab.results.remove_tooltip')}
							data-testid="upgrade-candidate-remove"
							onClick={() => removeUpgradeCandidate(player, index)}>
							<Icon name="times" />
						</Button>
					</div>
				);
			})}
		</div>
	);
};
