export interface Quote {
  value: string;
  currency: string;
}

export interface MarketSide {
  id: string;
  identifier: string;
  description: string; // "Yes" | "No" | team name
  price?: string;
  quote?: Quote;
  long?: boolean;
  tradable?: boolean;
  marketSideType?: string;
}

export interface PmMarket {
  id: string;
  slug: string;
  question?: string;
  title?: string;
  titleShort?: string;
  description?: string;
  category?: string;
  active?: boolean;
  closed?: boolean;
  hidden?: boolean;
  status?: string;
  marketType?: string;
  sportsMarketType?: string;
  sportsMarketTypeV2?: string;
  feeCoefficient?: number;
  orderPriceMinTickSize?: number;
  minimumTradeQty?: number;
  bestAskQuote?: Quote;
  bestBidQuote?: Quote;
  outcomes?: string;
  outcomePrices?: string;
  marketSides?: MarketSide[];
  volume24hr?: number | string;
  volume?: number | string;
  line?: number;
  endDate?: string;
  image?: string;
}

export interface MarketGroup {
  id: string;
  title?: string;
  subtitle?: string;
  marketIds?: (string | number)[];
  line?: number;
}

export interface PmEvent {
  id: string;
  slug: string;
  ticker?: string;
  title: string;
  description?: string;
  category?: string;
  active?: boolean;
  closed?: boolean;
  live?: boolean;
  startDate?: string;
  endDate?: string;
  image?: string;
  volume24hr?: number | string;
  volume?: number | string;
  liquidity?: number | string;
  openInterest?: number | string;
  markets?: PmMarket[];
  marketGroups?: MarketGroup[];
  tags?: unknown[];
  seriesSlug?: string;
}

export interface BboResponse {
  marketData: {
    marketSlug: string;
    currentPx?: Quote;
    lastTradePx?: Quote;
    settlementPx?: Quote;
    sharesTraded?: string;
    openInterest?: string;
    bestAsk?: Quote;
    bestBid?: Quote;
    askDepth?: number;
    bidDepth?: number;
  };
}

export interface BookLevel {
  px: Quote;
  qty: string;
}

export interface BookResponse {
  marketData: {
    marketSlug: string;
    bids?: BookLevel[];
    /** The live API sends the ask side as `offers`; PmusClient.getMarketBook
     * normalizes it into `asks` so consumers see one name. */
    asks?: BookLevel[];
    offers?: BookLevel[];
  };
}

export interface Balance {
  currentBalance: number;
  currency: string;
  buyingPower: number;
  assetNotional: number;
  openOrders: number;
  unsettledFunds: number;
}

export interface BalancesResponse {
  balances: Balance[];
}

export const num = (v: number | string | undefined | null): number => {
  if (v === undefined || v === null) return 0;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

export const quotePx = (q?: Quote): number | undefined => {
  if (!q?.value) return undefined;
  const n = parseFloat(q.value);
  return Number.isFinite(n) ? n : undefined;
};
