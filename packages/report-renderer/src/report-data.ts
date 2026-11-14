export interface ProjectShare {
	readonly projectId: string | null;
	readonly projectName: string | null;
	readonly clientName: string | null;
	readonly seconds: number;
	readonly displayName?: string;
}

export interface ReportLine {
	readonly clientName: string | null;
	readonly projectName: string | null;
	readonly description: string;
	readonly groupLabel?: string;
	readonly seconds: number;
	readonly hourlyRateOre: bigint | null;
	readonly amountOre: bigint;
}

export interface ReportData {
	readonly language: 'en' | 'sv';
	readonly ownerName: string;
	readonly numberLocale?: string;
	readonly logo?: Buffer;
	readonly showMoney: boolean;
	readonly scope: {
		readonly from: string;
		readonly to: string;
		readonly clientName: string | null;
		readonly projectName: string | null;
		readonly billability: 'all' | 'billable' | 'nonBillable';
		readonly invoiceStatus: 'all' | 'invoiced' | 'uninvoiced';
		readonly description?: string;
		readonly invoiceNumber?: string;
	};
	readonly totalSeconds: number;
	readonly totalAmountOre: bigint;
	readonly days: readonly { readonly date: string; readonly seconds: number }[];
	readonly projectShares: readonly ProjectShare[];
	readonly summaries: readonly ReportLine[];
	readonly details?: readonly (ReportLine & { readonly date: string })[];
}

export type ReportRenderer = (data: ReportData) => Promise<Buffer>;
