import { BulkItemSearchRow } from '@features/bulk/components/BulkItemSearch/BulkItemSearchRow';
import { type BulkSearchResult, byIlvlDescending, MAX_SEARCH_RESULTS, searchBulkItems } from '@features/bulk/model/search';
import { ItemSpec } from '@generated/proto/common';
import i18n from '@i18n/config';
import { usePlayer } from '@sim/context/SimHostContext';
import { canEquipItem } from '@sim/proto/items';
import { ComboBox } from '@ui-kit/ComboBox';
import { ContentBlock } from '@ui-kit/ContentBlock';
import { useEffect, useMemo, useState } from 'react';

import { addUpgradeCandidate } from '../../model/items';

export interface UpgradeItemSearchProps {
	ready: boolean;
}

// The finder's search box shares the batch's index and row rendering; it differs
// only in where a picked item lands (the candidate list instead of the picker group).
export const UpgradeItemSearch = ({ ready }: UpgradeItemSearchProps) => {
	const player = usePlayer();
	const [query, setQuery] = useState('');
	const allItems = useMemo(
		() =>
			ready
				? player.sim.db
						.getAllItems()
						.filter(item => canEquipItem(item, player.getPlayerSpec(), undefined))
						.sort(byIlvlDescending)
				: [],
		[ready, player],
	);

	const [dismissed, setDismissed] = useState(false);
	const hasQuery = query.length > 0;
	const open = hasQuery && !dismissed;
	const matches = useMemo(() => (hasQuery ? searchBulkItems(allItems, query, 0, 0) : null), [hasQuery, allItems, query]);
	// Clearing the box hides the list without emptying it.
	const [shown, setShown] = useState<BulkSearchResult | null>(null);
	useEffect(() => {
		if (matches) setShown(matches);
	}, [matches]);

	return (
		<ContentBlock config={{ header: { title: i18n.t('upgrade_tab.search.title'), className: 'pb-0 border-b-0' } }} flush>
			<div className="border border-border bg-background p-4">
				<ComboBox
					id="upgradeItemSearch"
					label={i18n.t('common.name')}
					placeholder={i18n.t('common.search')}
					value={query}
					onChange={next => {
						setDismissed(false);
						setQuery(next);
					}}
					open={open}
					onOpenChange={(next, reason) => setDismissed(!next && reason === 'escape-key')}
					items={shown?.items ?? []}
					itemKey={item => item.id}
					renderItem={item => <BulkItemSearchRow item={item} />}
					onItemSelect={item => addUpgradeCandidate(player, ItemSpec.create({ id: item.id }))}
					clearable
					clearLabel={i18n.t('bulk_tab.search.clear_search')}
					listTestId="upgrade-item-search-results"
					footer={
						<>
							{!!shown && shown.matchCount > MAX_SEARCH_RESULTS && (
								<div className="ui-combo-box-footer" data-testid="upgrade-item-search-results-note">
									{i18n.t('bulk_tab.search.showing_results', { max: MAX_SEARCH_RESULTS, total: shown.matchCount })}
								</div>
							)}
							{shown?.matchCount === 0 && (
								<div className="ui-combo-box-footer" data-testid="upgrade-item-search-results-note">
									{i18n.t('bulk_tab.search.no_results')}
								</div>
							)}
						</>
					}
				/>
			</div>
		</ContentBlock>
	);
};
