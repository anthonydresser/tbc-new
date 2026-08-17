import { ref } from 'tsx-vanilla';

import { IndividualSimUI } from '../../../individual_sim_ui';
import { ItemSpec } from '../../../proto/common';
import { bisListJsonExample, parseBisListJson } from '../../../proto_utils/bis_list_parser';
import { Importer } from '../../importer';
import Toast from '../../toast';
import i18n from '../../../../i18n/config';

export interface BisListImportResult {
	itemSpecs: ItemSpec[];
}

export interface BisListJsonImporterOptions {
	onImport: (result: BisListImportResult) => void | Promise<void>;
}

export class BisListJsonImporter extends Importer {
	protected readonly simUI: IndividualSimUI<any>;
	private readonly onImportCallback: (result: BisListImportResult) => void | Promise<void>;

	constructor(parent: HTMLElement, simUI: IndividualSimUI<any>, options: BisListJsonImporterOptions) {
		super(parent, { title: i18n.t('upgrade_tab.import_bis_list.title'), allowFileUpload: true });

		this.simUI = simUI;
		this.onImportCallback = options.onImport;

		this.descriptionElem.appendChild(
			<div>
				<p>{i18n.t('upgrade_tab.import_bis_list.description')}</p>
				<p>{i18n.t('upgrade_tab.import_bis_list.instructions')}</p>
				<details className="bis-list-example">
					<summary>{i18n.t('upgrade_tab.import_bis_list.example_summary')}</summary>
					<pre className="bis-list-example-code">
						<code>{bisListJsonExample()}</code>
					</pre>
				</details>
			</div>,
		);
	}

	async onImport(data: string) {
		const result = await parseBisListJson(data);

		const formatErrorMessages = () => {
			const messages = result.errors.slice(0, 5).map(e => e.message);
			if (result.errors.length > 5) {
				messages.push(i18n.t('upgrade_tab.import_bis_list.more_errors', { count: result.errors.length - 5 }));
			}
			return messages.join('\n');
		};

		if (result.itemSpecs.length === 0 && result.errors.length > 0) {
			throw new Error(formatErrorMessages());
		}

		await this.onImportCallback({
			itemSpecs: result.itemSpecs,
		});

		this.close();

		if (result.errors.length > 0) {
			new Toast({
				variant: 'warning',
				body: (
					<>
						{i18n.t('upgrade_tab.import_bis_list.imported_with_warnings', {
							count: result.itemSpecs.length,
							errors: formatErrorMessages(),
						})}
					</>
				),
			});
		}
	}
}
