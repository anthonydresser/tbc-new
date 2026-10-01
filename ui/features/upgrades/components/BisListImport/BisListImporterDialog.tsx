import { Importer } from '@features/import-export';
import i18n from '@i18n/config';
import { bisListJsonExample } from '@sim/upgrade/bis_list_parser';

import { BIS_LIST_IMPORTER } from '../../model/bis';

export interface BisListImporterDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}

export const BisListImporterDialog = ({ open, onOpenChange }: BisListImporterDialogProps) => (
	<Importer open={open} onOpenChange={onOpenChange} {...BIS_LIST_IMPORTER}>
		<p>{i18n.t('upgrade_tab.import_bis_list.description')}</p>
		<p>{i18n.t('upgrade_tab.import_bis_list.instructions')}</p>
		<details className="bis-list-example">
			<summary>{i18n.t('upgrade_tab.import_bis_list.example_summary')}</summary>
			<pre className="bis-list-example-code">
				<code>{bisListJsonExample()}</code>
			</pre>
		</details>
	</Importer>
);
