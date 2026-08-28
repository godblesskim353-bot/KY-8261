import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter, useLocation } from 'wouter';
import {
  getGetPolymarketLiveSnapshotQueryKey,
  getGetPolymarketStatusQueryKey,
  setBaseUrl,
  useArmPolymarketExecution,
  useGetPolymarketLiveSnapshot,
  useGetPolymarketStatus,
  usePausePolymarketExecution,
} from '@workspace/api-client-react';
import type { PolymarketLiveSnapshot } from '@workspace/api-client-react';
import {
  Activity, ArrowDownRight, ArrowUpRight, BarChart3, Blocks, Crosshair, Gauge,
  Info, Layers3, LockKeyhole, ShieldAlert, ShieldCheck, Target, Terminal,
  TrendingDown, TrendingUp, Wifi,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

const queryClient = new QueryClient();
const ENTRY_PRICE_MIN = 0.4;
const ENTRY_PRICE_MAX = 0.82;
const INVENTORY_BOUND = 250;
const remoteApiBase = import.meta.env.VITE_API_BASE_URL?.trim();
if (remoteApiBase) setBaseUrl(remoteApiBase);

const formatUsd = (value: number | null | undefined, fractionDigits = 2) =>
  value === null || value === undefined
    ? '—'
    : `$${value.toLocaleString('en-US', { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`;

const formatCents = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : `${(value * 100).toFixed(1)}¢`;

const formatShares = (value: number | null | undefined) =>
  value === null || value === undefined ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 2 });

const formatSigned = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;

const timestampLabel = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleTimeString('en-GB', { hour12: false }) : '—';

const ageMs = (value: string | null | undefined, now: number) =>
  value ? Math.max(0, now - new Date(value).getTime()) : null;

function Badge({ children, tone = 'slate', pulse = false }: { children: ReactNode; tone?: 'teal' | 'amber' | 'coral' | 'slate'; pulse?: boolean }) {
  const tones = {
    teal: 'bg-[#d9f2e9] text-[#176856] border-[#acdcca]',
    amber: 'bg-[#fff0cc] text-[#8b5a08] border-[#f1cc78]',
    coral: 'bg-[#ffe0dc] text-[#9e342b] border-[#f0b2aa]',
    slate: 'bg-[#e7e9e7] text-[#43505a] border-[#cbd0cc]',
  };
  return <span className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-bold uppercase tracking-[.11em] ${tones[tone]}`}><span className={`mr-1.5 h-1.5 w-1.5 rounded-full bg-current ${pulse ? 'live-pulse' : ''}`} />{children}</span>;
}

function SectionHeader({ eyebrow, title, action }: { eyebrow: string; title: string; action?: ReactNode }) {
  return <div className="mb-4 flex items-start justify-between gap-3"><div><div className="eyebrow text-[#7d8785]">{eyebrow}</div><h2 className="mt-1 font-display text-[17px] font-semibold tracking-[-.02em] text-[#24343a]">{title}</h2></div>{action}</div>;
}

function MetricCard({ label, value, sub, Icon, tone = 'teal', trend }: { label: string; value: string; sub: string; Icon: LucideIcon; tone?: 'teal' | 'amber' | 'coral'; trend?: 'up' | 'down' }) {
  const iconClass = tone === 'teal' ? 'bg-[#d9f2e9] text-[#167662]' : tone === 'amber' ? 'bg-[#fff0cc] text-[#a26908]' : 'bg-[#ffe0dc] text-[#b34238]';
  return <div className="panel rounded-xl p-4"><div className="flex items-start justify-between"><span className="eyebrow text-[#7d8785]">{label}</span><span className={`grid h-8 w-8 place-items-center rounded-lg ${iconClass}`}><Icon size={15} /></span></div><div className="mt-4 flex items-end justify-between gap-2"><div><div className="font-display text-[25px] font-semibold leading-none tracking-[-.04em] text-[#25363b]">{value}</div><div className="mt-2 text-[11px] font-medium text-[#7d8785]">{sub}</div></div>{trend && <span className={trend === 'up' ? 'text-[#16826c]' : 'text-[#c95d51]'}>{trend === 'up' ? <ArrowUpRight size={18} /> : <ArrowDownRight size={18} />}</span>}</div></div>;
}

function NavRail({ executionState }: { executionState?: string }) {
  return <aside className="fixed inset-y-0 left-0 z-20 hidden w-[224px] flex-col border-r border-[#d8dcd7] bg-[#f2f1eb] px-3 py-4 md:flex">
    <div className="flex items-center gap-2.5 px-2"><div className="grid h-9 w-9 place-items-center rounded-xl bg-[#20373b] text-[#f6c768] shadow-sm"><Crosshair size={18} /></div><div><div className="font-display text-[14px] font-bold tracking-[-.03em] text-[#20373b]">CIRCUIT / 05</div><div className="eyebrow mt-0.5 text-[#84908d]">live data console</div></div></div>
    <div className="mt-10 space-y-1"><div className="eyebrow px-3 pb-2 text-[#9aa39f]">workspace</div><a href="#overview" className="flex w-full items-center gap-3 rounded-lg bg-[#dbece6] px-3 py-2.5 text-[12px] font-bold text-[#176856]"><Gauge size={16} />Control room</a><a href="#quote-surface" className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[12px] font-semibold text-[#6b7773] transition hover:bg-[#e4e6e0]"><Terminal size={16} />Quote surface</a><a href="#risk-panel" className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-[12px] font-semibold text-[#6b7773] transition hover:bg-[#e4e6e0]"><ShieldAlert size={16} />Risk controls</a></div>
    <div className="mt-auto rounded-lg border border-[#e4e2d9] bg-[#ebeae3] px-3 py-2.5"><div className="flex items-center gap-2"><ShieldCheck size={14} className={executionState === 'HALTED' ? 'text-[#b34238]' : 'text-[#16826c]'} /><span className="text-[10px] font-semibold leading-tight text-[#727c79]">BINANCE DUAL-TRACK<br /><span className="font-normal">{executionState ?? 'loading controller'}</span></span></div></div>
  </aside>;
}

function TopBar({ data }: { data?: PolymarketLiveSnapshot }) {
  const live = Boolean(data?.ready);
  const condition = data?.market.conditionId;
  const execution = data?.execution;
  const executionTone = execution?.state === 'HALTED' ? 'coral' : execution?.enabled ? 'teal' : 'slate';
  return <header className="sticky top-0 z-10 flex min-h-[68px] items-center justify-between gap-3 border-b border-[#d8dcd7] bg-[#f2f1eb]/95 px-4 backdrop-blur md:ml-[224px] md:px-7">
    <div><div className="eyebrow text-[#89938f]">market / btc binary pair</div><div className="mt-0.5 flex items-center gap-2 text-[12px] font-semibold text-[#34474a]"><span>Polymarket CLOB V2</span><span className="text-[#adb4b0]">•</span><span className="font-mono text-[11px] text-[#6c7976]">{condition ? `${condition.slice(0, 10)}…${condition.slice(-6)}` : 'market identifiers required'}</span></div></div>
    <div className="flex items-center gap-2.5"><div className="flex items-center gap-2 rounded-full border border-[#d8d7] bg-[#f9f8f3] px-3 py-2 text-[10px] font-semibold text-[#697672]"><Wifi size={13} className={live ? 'text-[#16826c]' : 'text-[#b9811f]'} /><span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-[#16826c] live-pulse' : 'bg-[#b9811f]'}`} />{live ? 'feeds live' : 'awaiting feeds'}</div><Badge tone={executionTone} pulse={Boolean(execution?.enabled && execution.state === 'ARMED')}>{execution?.state ?? 'controller loading'}</Badge></div>
  </header>;
}

function StatusHero({ data, now }: { data?: PolymarketLiveSnapshot; now: number }) {
  const dataAge = ageMs(data?.market.lastBookAt, now);
  const live = Boolean(data?.ready);
  const execution = data?.execution;
  return <section className="panel-dark relative overflow-hidden rounded-2xl p-5 sm:p-7"><div className="absolute right-0 top-0 h-44 w-44 rounded-full bg-[#f6c768]/[.06] blur-2xl" /><div className="relative flex flex-col justify-between gap-7 lg:flex-row lg:items-end"><div><div className="eyebrow flex items-center gap-2 text-[#99b4ac]"><span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-[#72d6b4] live-pulse' : 'bg-[#f6c768]'}`} />Server-observed market status</div><h1 data-testid="status-primary" className="mt-3 max-w-xl font-display text-3xl font-semibold leading-[1.03] tracking-[-.055em] sm:text-[43px]">{execution?.state === 'HALTED' ? 'Execution halted.' : live ? 'Live data flowing.' : 'Awaiting verified data.'}</h1><p className="mt-3 max-w-lg text-[12px] leading-5 text-[#a9bcb7]">{execution?.reason ?? data?.message ?? 'Connecting to the server-side market data bridge.'}</p></div><div className="grid grid-cols-2 gap-6"><div><div className="eyebrow text-[#99b4ac]">CLOB book age</div><div className={`mt-2 font-mono text-3xl font-medium tracking-[-.08em] ${live ? 'text-[#f7d27a]' : 'text-[#ee8279]'}`}>{dataAge === null ? '—' : `${(dataAge / 1000).toFixed(1)}s`}</div><div className="mt-1 text-[10px] text-[#829a94]">server timestamp</div></div><div><div className="eyebrow text-[#99b4ac]">execution</div><div className={`mt-2 font-mono text-xl font-medium tracking-[-.06em] ${execution?.state === 'HALTED' ? 'text-[#ee8279]' : 'text-[#e6efea]'}`}>{execution?.state ?? '—'}</div><div className="mt-1 text-[10px] text-[#829a94]">{execution?.mode ?? 'BINANCE DUAL-TRACK'}</div></div></div></div><div className="relative mt-7 grid grid-cols-2 gap-2 border-t border-[#45605d] pt-4 sm:grid-cols-4"><div><div className="eyebrow text-[#77928b]">signal source</div><div className="mt-1 text-[12px] font-semibold text-[#e6efea]">{data?.spot.connected ? 'BINANCE PERPETUAL' : 'CONNECTING'}</div></div><div><div className="eyebrow text-[#77928b]">CLOB stream</div><div className="mt-1 text-[12px] font-semibold text-[#e6efea]">{data?.market.streamConnected ? 'CONNECTED' : 'WAITING'}</div></div><div><div className="eyebrow text-[#77928b]">wallet source</div><div className="mt-1 text-[12px] font-semibold text-[#e6efea]">{data?.wallet.source ?? '—'}</div></div><div><div className="eyebrow text-[#77928b]">track</div><div className="mt-1 text-[12px] font-semibold text-[#e6efea]">{execution?.branch ? `BRANCH ${execution.branch}` : execution?.enabled ? 'DUAL-TRACK ARMED' : 'OBSERVE'}</div></div></div></section>;
}

function MarketPanel({ data }: { data?: PolymarketLiveSnapshot }) {
  const quotes = data?.quotes;
  const edge = quotes?.edge;
  return <section id="quote-surface" className="panel rounded-xl p-5"><SectionHeader eyebrow="read-only execution prices" title="Polymarket quote surface" action={<Badge tone={quotes?.fresh ? 'teal' : 'amber'} pulse={Boolean(quotes?.fresh)}>{quotes?.fresh ? 'streaming' : 'stale / waiting'}</Badge>} /><div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1.1fr]"><div className="rounded-lg border border-[#b6ded1] bg-[#e8f6f0] p-4"><div className="flex items-center justify-between"><span className="eyebrow text-[#4f8174]">UP best ask</span><ArrowUpRight size={15} className="text-[#16826c]" /></div><div data-testid="text-yes-ask" className="mt-3 font-mono text-3xl font-medium tracking-[-.07em] text-[#176856]">{formatCents(quotes?.yesBestAsk)}</div><div className="mt-2 flex justify-between text-[10px] font-medium text-[#4e8274]"><span>size {formatShares(quotes?.yesAskSize)}</span><span>bid {formatCents(quotes?.yesBestBid)}</span></div></div><div className="rounded-lg border border-[#f0d59a] bg-[#fff8e7] p-4"><div className="flex items-center justify-between"><span className="eyebrow text-[#9b6b1b]">DOWN best ask</span><ArrowDownRight size={15} className="text-[#b9811f]" /></div><div data-testid="text-no-ask" className="mt-3 font-mono text-3xl font-medium tracking-[-.07em] text-[#8d620e]">{formatCents(quotes?.noBestAsk)}</div><div className="mt-2 flex justify-between text-[10px] font-medium text-[#96723a]"><span>size {formatShares(quotes?.noAskSize)}</span><span>bid {formatCents(quotes?.noBestBid)}</span></div></div><div className="rounded-lg border border-[#d7deda] bg-[#f7f8f4] p-4"><div className="flex items-center justify-between"><span className="eyebrow text-[#697773]">pair total</span><span className="rounded bg-[#e7e9e7] px-1.5 py-0.5 font-mono text-[9px] font-medium text-[#43505a]">OBSERVATION ONLY</span></div><div data-testid="text-combined-ask" className="mt-3 font-mono text-3xl font-medium tracking-[-.07em] text-[#24343a]">{formatCents(quotes?.combinedAsk)}</div><div className="mt-2 flex justify-between text-[10px] font-medium text-[#697773]"><span>common depth {formatShares(quotes?.commonDepth)}</span><span>{edge === null || edge === undefined ? '—' : `${formatSigned(edge * 100, 2)}¢ complement`}</span></div></div></div><p className="mt-4 border-t border-[#e1e4de] pt-4 text-[10px] leading-4 text-[#70817b]">Combined ask and pair edge are displayed for context only. They do not open or block the Binance-driven entry gate.</p></section>;
}

function SpotPanel({ data, now }: { data?: PolymarketLiveSnapshot; now: number }) {
  const spot = data?.spot;
  const change = spot?.momentum1sPct;
  const positive = (change ?? 0) >= 0;
  const lag = ageMs(spot?.lastEventAt, now);
  return <section className="panel rounded-xl p-5"><SectionHeader eyebrow="reference feed" title="BTC spot / 1s breakout" action={<span className="font-mono text-[10px] text-[#8c9793]">BINANCE BTCUSDT</span>} /><div className="flex items-end justify-between gap-4"><div><div data-testid="text-btc-spot" className="font-mono text-[27px] font-medium tracking-[-.07em] text-[#24343a]">{formatUsd(spot?.priceUsd, 2)}</div><div className={`mt-2 flex items-center gap-1 text-[11px] font-semibold ${positive ? 'text-[#16826c]' : 'text-[#c95d51]'}`}>{positive ? <TrendingUp size={14} /> : <TrendingDown size={14} />}{change === null || change === undefined ? '—' : `${formatSigned(change, 4)}%`} <span className="font-normal text-[#87918d]">last 1 sec</span></div></div><div className="rounded-lg border border-[#e1e4de] bg-[#f7f8f4] px-4 py-3 text-right"><div className="eyebrow text-[#8c9793]">stream event</div><div className="mt-1 font-mono text-[12px] text-[#34474a]">{timestampLabel(spot?.lastEventAt)}</div></div></div><div className="mt-5 grid grid-cols-3 gap-2 border-t border-[#e1e4de] pt-4"><div><div className="eyebrow text-[#8c9793]">momentum / 1s</div><div data-testid="text-volatility" className="mt-1 font-mono text-[12px] text-[#34474a]">{change === null || change === undefined ? '—' : `${formatSigned(change, 4)}%`}</div></div><div><div className="eyebrow text-[#8c9793]">feed lag</div><div className="mt-1 font-mono text-[12px] text-[#16826c]">{lag === null ? '—' : `${lag}ms`}</div></div><div><div className="eyebrow text-[#8c9793]">connection</div><div className="mt-1 font-mono text-[12px] text-[#34474a]">{spot?.connected ? 'STREAMING' : 'WAITING'}</div></div></div></section>;
}

function DirectionPanel({ data }: { data?: PolymarketLiveSnapshot }) {
  const signal = data?.signal;
  const confirmed = Boolean(signal?.confirmed);
  const direction = signal?.selectedDirection ?? 'WAIT';
  return <section className="panel rounded-xl p-5">
    <SectionHeader eyebrow="Binance perpetual microstructure" title="4× depth wall + 50ms flow" action={<Badge tone={confirmed ? 'teal' : 'amber'} pulse={confirmed}>{confirmed ? `${direction} confirmed` : 'skip entry'}</Badge>} />
    <div className="grid grid-cols-3 gap-2">
      <div className="rounded-lg border border-[#e1e4de] bg-[#f7f8f4] p-3"><div className="eyebrow text-[#8c9793]">top-3 wall</div><div className="mt-2 font-mono text-lg font-semibold text-[#34474a]">{signal?.btcDirection ?? 'NONE'} · {signal?.topThreeImbalanceRatio?.toFixed(2) ?? '—'}×</div></div>
      <div className="rounded-lg border border-[#e1e4de] bg-[#f7f8f4] p-3"><div className="eyebrow text-[#8c9793]">aggressive flow / 50ms</div><div className="mt-2 font-mono text-sm font-semibold text-[#34474a]">B {signal?.aggressiveBuyVolumeBtc.toFixed(2) ?? '—'} / S {signal?.aggressiveSellVolumeBtc.toFixed(2) ?? '—'} BTC</div></div>
      <div className={`rounded-lg border p-3 ${confirmed ? 'border-[#b6ded1] bg-[#e8f6f0]' : 'border-[#f0d59a] bg-[#fff8e7]'}`}><div className="eyebrow text-[#8c9793]">selected side</div><div className={`mt-2 font-mono text-lg font-semibold ${confirmed ? 'text-[#176856]' : 'text-[#9b6b1b]'}`}>{direction}</div></div>
    </div>
    <p className="mt-3 text-[10px] leading-4 text-[#70817b]">{signal?.reason ?? 'Waiting for a 4× Binance wall and more than 10 BTC matching aggressive flow inside 50ms.'}</p>
  </section>;
}

function RiskPanel({ data }: { data?: PolymarketLiveSnapshot }) {
  const q = data?.quotes;
  const i = data?.inventory;
  const selectedEntryAsk = data?.signal.selectedDirection === 'UP' ? q?.yesBestAsk : data?.signal.selectedDirection === 'DOWN' ? q?.noBestAsk : null;
  const selectedEntryAskInBand = selectedEntryAsk !== null && selectedEntryAsk !== undefined && selectedEntryAsk >= ENTRY_PRICE_MIN && selectedEntryAsk <= ENTRY_PRICE_MAX;
  const rows = [
    ['Binance depth wall', '≥ 4.00×', data?.signal.topThreeImbalanceRatio?.toFixed(2) ?? '—', (data?.signal.topThreeImbalanceRatio ?? 0) >= 4],
    ['Matching aggressive flow', '> 10 BTC / 50ms', data?.signal.selectedDirection === 'DOWN' ? data.signal.aggressiveSellVolumeBtc.toFixed(2) : data?.signal.aggressiveBuyVolumeBtc.toFixed(2) ?? '—', Boolean(data?.signal.confirmed)],
    ['Selected entry ask', '40–82¢', formatCents(selectedEntryAsk), selectedEntryAskInBand],
    ['Inventory bound', '± 250', formatSigned(i?.netShares, 2), i?.netShares !== null && i?.netShares !== undefined && Math.abs(i.netShares) <= INVENTORY_BOUND],
    ['Order book freshness', '< 8 sec', q?.fresh ? 'fresh' : 'waiting', Boolean(q?.fresh)],
  ] as const;
  return <section id="risk-panel" className="panel rounded-xl p-5"><SectionHeader eyebrow="pre-trade gate" title="Risk & strategy" action={<Badge tone={data?.ready ? 'teal' : 'amber'} pulse={Boolean(data?.ready)}>{data?.ready ? 'observing live' : 'not ready'}</Badge>} /><div className={`mb-4 flex items-center gap-3 rounded-lg border px-3 py-2.5 ${data?.ready ? 'border-[#b6ded1] bg-[#e8f6f0]' : 'border-[#f0d59a] bg-[#fff8e7]'}`}><span className={`grid h-7 w-7 place-items-center rounded-full ${data?.ready ? 'bg-[#bee5d5] text-[#176856]' : 'bg-[#f4deab] text-[#9b6b1b]'}`}>{data?.ready ? <ShieldCheck size={15} /> : <ShieldAlert size={15} />}</span><div><div className={`text-[11px] font-bold ${data?.ready ? 'text-[#176856]' : 'text-[#9b6b1b]'}`}>{data?.ready ? 'Live data checks passing' : 'Live data checks waiting'}</div><div className="text-[10px] text-[#70817b]">Entry is Binance-only: top-three depth ≥4× plus &gt;10 BTC matching aggressive flow within 50ms. First FAK uses ask +1¢ capped at 82¢, then immediately places the opposite GTC defense. Branches A/B/C are mutually exclusive.</div></div></div><div className="space-y-2.5">{rows.map(([name, limit, current, pass]) => <div key={name} className="flex items-center justify-between gap-3 text-[11px]"><span className="font-medium text-[#53625f]">{name}</span><span className="ml-auto font-mono text-[10px] text-[#8b9691]">{limit}</span><span className={`min-w-[54px] text-right font-mono font-medium ${pass ? 'text-[#34474a]' : 'text-[#b94c42]'}`}>{current}</span><span className={`h-1.5 w-1.5 rounded-full ${pass ? 'bg-[#16826c]' : 'bg-[#c95d51]'}`} /></div>)}</div></section>;
}

function InventoryPanel({ data }: { data?: PolymarketLiveSnapshot }) {
  const inventory = data?.inventory;
  const net = inventory?.netShares;
  const ratio = net === null || net === undefined ? 0 : Math.min(1, Math.abs(net) / INVENTORY_BOUND);
  const balanced = net !== null && net !== undefined && Math.abs(net) <= INVENTORY_BOUND;
  return <section className="panel rounded-xl p-5"><SectionHeader eyebrow="balance sheet" title="Wallet & inventory" action={<Badge tone={balanced ? 'teal' : 'amber'}>{balanced ? 'within bound' : 'awaiting data'}</Badge>} /><div className="flex items-center gap-5"><div className="relative grid h-[116px] w-[116px] shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(#16826c 0deg ${Math.max(10, ratio * 360)}deg, #e3e7e1 ${Math.max(10, ratio * 360)}deg 360deg)` }}><div className="grid h-[92px] w-[92px] place-items-center rounded-full bg-[#fafaf6]"><div className="text-center"><div className="eyebrow text-[#8c9793]">net units</div><div data-testid="text-inventory" className="mt-1 font-mono text-[19px] font-medium text-[#34474a]">{formatSigned(net, 2)}</div></div></div></div><div className="min-w-0 flex-1 space-y-3"><div className="flex justify-between text-[11px]"><span className="text-[#687773]">YES shares</span><span className="font-mono font-medium text-[#34474a]">{formatShares(inventory?.yesShares)}</span></div><div className="flex justify-between text-[11px]"><span className="text-[#687773]">NO shares</span><span className="font-mono font-medium text-[#34474a]">{formatShares(inventory?.noShares)}</span></div><div className="flex justify-between border-t border-[#e1e4de] pt-2 text-[11px]"><span className="font-semibold text-[#53625f]">wallet pUSD</span><span data-testid="text-wallet-balance" className="font-mono font-medium text-[#16826c]">{formatUsd(data?.wallet.balancePusd)}</span></div><div className="flex justify-between text-[11px]"><span className="font-semibold text-[#53625f]">positions value</span><span className="font-mono font-medium text-[#34474a]">{formatUsd(inventory?.atRiskPusd)}</span></div></div></div><div className="mt-5 rounded-lg border border-[#ebe4d6] bg-[#fbf6e9] p-3 text-[10px] leading-4 text-[#82692d]"><Info size={14} className="mr-2 inline-block align-text-top" />Balance: {data?.wallet.source ?? '—'} · Positions: {inventory?.source ?? '—'}</div></section>;
}

function CompoundPanel({ data }: { data?: PolymarketLiveSnapshot }) {
  const compound = data?.compound;
  return <section className="panel rounded-xl p-5"><SectionHeader eyebrow="capital engine / module 08" title="Pair capacity" action={<Badge tone={compound?.executable ? 'teal' : 'amber'}>{compound?.executable ? compound.reason.replaceAll('_', ' ') : 'not executable'}</Badge>} /><div className="rounded-lg border border-[#b6ded1] bg-[#e8f6f0] p-4"><div className="eyebrow text-[#4f8174]">maximum protected pair cost</div><div data-testid="text-compound-stake" className="mt-2 font-mono text-3xl font-medium tracking-[-.07em] text-[#176856]">{formatUsd(compound?.finalExecutionStakePusd)} <span className="text-sm tracking-normal">pUSD</span></div><div className="mt-3 grid grid-cols-3 gap-2 border-t border-[#c8e6db] pt-3 text-[10px]"><div><div className="text-[#6c8d83]">verified wallet</div><div className="mt-1 font-mono font-semibold text-[#34474a]">{formatUsd(compound?.walletMaxStakePusd)}</div></div><div><div className="text-[#6c8d83]">pair liquidity</div><div className="mt-1 font-mono font-semibold text-[#34474a]">{formatUsd(compound?.marketAvailableVolumePusd)}</div></div><div><div className="text-[#6c8d83]">common depth</div><div className="mt-1 font-mono font-semibold text-[#34474a]">{formatShares(data?.quotes.commonDepth)}</div></div></div></div><div className="mt-3 flex items-start gap-2 rounded-lg border border-[#ebe4d6] bg-[#fbf6e9] p-3 text-[10px] leading-4 text-[#82692d]"><Info size={14} className="mt-0.5 shrink-0" /><span>Size is limited only by verified wallet collateral and current common depth × combined ask. There is no percentage wallet cap or baseline balance.</span></div></section>;
}

function ExecutionPanel({ data }: { data?: PolymarketLiveSnapshot }) {
  const execution = data?.execution;
  const refreshExecution = () => {
    void queryClient.invalidateQueries({ queryKey: getGetPolymarketLiveSnapshotQueryKey() });
    void queryClient.invalidateQueries({ queryKey: getGetPolymarketStatusQueryKey() });
  };
  const arm = useArmPolymarketExecution({ mutation: { onSuccess: refreshExecution } });
  const pause = usePausePolymarketExecution({ mutation: { onSuccess: refreshExecution } });
  const halted = execution?.state === 'HALTED';
  const autoRunning = Boolean(execution?.enabled && execution?.armed && !halted);
  const busy = arm.isPending || pause.isPending;
  const toggleLabel = autoRunning ? 'PAUSE NEW ENTRIES' : halted ? 'KILL SWITCH ACTIVE' : execution?.enabled ? 'START AUTO EXECUTION' : 'SERVER MASTER SWITCH OFF';
  const toggleClick = () => autoRunning ? pause.mutate(undefined) : arm.mutate(undefined);
  const orderLabel = (value: string | null | undefined) => value ? `${value.slice(0, 9)}…` : '—';
  return <section className="panel rounded-xl p-5">
    <SectionHeader eyebrow="server-side execution / VPS" title="Binance dual-track controller" action={<Badge tone={halted ? 'coral' : autoRunning ? 'teal' : 'amber'} pulse={autoRunning}>{execution?.state ?? 'loading'}</Badge>} />
    <div className="rounded-lg border border-[#e1e4de] bg-[#f7f8f4] p-3">
      <div className="eyebrow text-[#7d8785]">lifecycle reason</div>
      <p className="mt-1 text-[11px] leading-4 text-[#43505a]">{execution?.reason ?? 'Press START to begin automatic execution.'}</p>
      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[#e1e4de] pt-3 text-[10px]">
        <div><div className="text-[#7d8785]">selected side</div><div className="mt-1 font-mono font-semibold text-[#34474a]">{execution?.side ?? '—'}</div></div>
        <div><div className="text-[#7d8785]">remaining shares</div><div className="mt-1 font-mono font-semibold text-[#34474a]">{formatShares(execution?.remainingShares)}</div></div>
         <div><div className="text-[#7d8785]">entry / +0.05 trigger</div><div className="mt-1 font-mono font-semibold text-[#34474a]">{formatCents(execution?.entryPricePusd)} → {formatCents(execution?.takeProfitPricePusd)}</div></div>
        <div><div className="text-[#7d8785]">10% planned cost</div><div className="mt-1 font-mono font-semibold text-[#34474a]">{formatUsd(execution?.plannedCostPusd)}</div></div>
        <div><div className="text-[#7d8785]">entry / defense order</div><div className="mt-1 truncate font-mono text-[#34474a]">{orderLabel(execution?.entryOrderId)} / {orderLabel(execution?.defenseOrderId)}</div></div>
        <div><div className="text-[#7d8785]">defense price / shares</div><div className="mt-1 truncate font-mono text-[#34474a]">{formatCents(execution?.defensePricePusd)} / {formatShares(execution?.defenseShares)}</div></div>
        <div><div className="text-[#7d8785]">branch / second side</div><div className="mt-1 truncate font-mono text-[#34474a]">{execution?.branch ?? '—'} / {execution?.secondSide ?? '—'}</div></div>
        <div><div className="text-[#7d8785]">second entry / target</div><div className="mt-1 truncate font-mono text-[#34474a]">{formatCents(execution?.secondEntryPricePusd)} → {formatCents(execution?.secondTargetPusd)}</div></div>
        <div><div className="text-[#7d8785]">second / exit order</div><div className="mt-1 truncate font-mono text-[#34474a]">{orderLabel(execution?.secondEntryOrderId)} / {orderLabel(execution?.exitOrderId)}</div></div>
      </div>
    </div>
    <div className={`mt-3 rounded-lg border px-3 py-2 text-[10px] ${execution?.lastError ? 'border-[#f0b2aa] bg-[#ffe0dc] text-[#9e342b]' : 'border-[#d6e7df] bg-[#eaf6f1] text-[#387163]'}`}>
       {execution?.lastError ?? 'A: +0.05 exit after confirmed defense cancellation. B: defense fills and waits for settlement. C: confirmed Binance reversal cancels defense, enters the opposite side with a 20× C1 and wallet cap, then exits at 0.85/0.95.'}
    </div>
    <button type="button" onClick={toggleClick} disabled={busy || (!execution?.enabled && !autoRunning) || halted} className={`mt-3 w-full rounded-lg px-3 py-3 text-[11px] font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${autoRunning ? 'border border-[#d9c28a] bg-[#fff8e7] text-[#8d661e]' : 'border border-[#16826c] bg-[#e8f6f0] text-[#176856]'}`}>{busy ? 'UPDATING…' : toggleLabel}</button>
  </section>;
}

function ProxyPanel({ data, loading }: { data?: PolymarketLiveSnapshot; loading: boolean }) {
  const clobLive = Boolean(data?.market.streamConnected);
  return <section className="panel rounded-xl p-5"><SectionHeader eyebrow="execution perimeter" title="Live connection" action={<Badge tone={loading ? 'amber' : clobLive ? 'teal' : 'coral'} pulse={clobLive}>{loading ? 'checking' : clobLive ? 'CLOB live' : 'blocked'}</Badge>} /><div className="space-y-3"><div className="flex items-center justify-between rounded-lg bg-[#f0f2ed] px-3 py-3"><div className="flex items-center gap-2.5"><span className={`grid h-7 w-7 place-items-center rounded-md ${clobLive ? 'bg-[#d9f2e9] text-[#16826c]' : 'bg-[#ffe0dc] text-[#b34238]'}`}><Blocks size={15} /></span><div><div className="text-[11px] font-bold text-[#34474a]">Polymarket CLOB V2</div><div className="text-[10px] text-[#87918d]">residential-proxy WebSocket</div></div></div><div className={`font-mono text-[11px] ${clobLive ? 'text-[#16826c]' : 'text-[#b34238]'}`}>{clobLive ? 'connected' : 'waiting'}</div></div><div className="grid grid-cols-2 gap-2"><div className="rounded-lg border border-[#e1e4de] p-3"><div className="eyebrow text-[#8c9793]">market config</div><div className={`mt-1 font-mono text-[12px] ${data?.market.configured ? 'text-[#16826c]' : 'text-[#b34238]'}`}>{data?.market.configured ? 'configured' : 'missing IDs'}</div></div><div className="rounded-lg border border-[#e1e4de] p-3"><div className="eyebrow text-[#8c9793]">Binance spot</div><div className={`mt-1 font-mono text-[12px] ${data?.spot.connected ? 'text-[#16826c]' : 'text-[#b34238]'}`}>{data?.spot.connected ? 'connected' : 'waiting'}</div></div></div><div className="rounded-lg border border-[#ebe4d6] bg-[#fbf6e9] p-3 text-[10px] leading-4 text-[#82692d]"><Info size={14} className="mr-2 inline-block align-text-top" />{data?.message ?? 'Fetching server-side connection status. Secret values are never exposed in the browser.'}</div></div></section>;
}

function LiveEvents({ data }: { data?: PolymarketLiveSnapshot }) {
  const events = [
    { title: 'Binance BTCUSDT ticker', detail: data?.spot.connected ? `Last event ${timestampLabel(data.spot.lastEventAt)} · ${formatUsd(data.spot.priceUsd)}` : 'Awaiting ticker connection', Icon: Activity, tone: data?.spot.connected ? 'teal' : 'amber' },
    { title: 'Polymarket CLOB order book', detail: data?.market.streamConnected ? `Last book ${timestampLabel(data.market.lastBookAt)} · sequence ${data.sequence}` : 'Awaiting configured CLOB subscription', Icon: Blocks, tone: data?.market.streamConnected ? 'teal' : 'amber' },
    { title: 'Wallet balance source', detail: data?.wallet.source ?? 'Awaiting account status', Icon: LockKeyhole, tone: data?.wallet.balancePusd !== null ? 'teal' : 'slate' },
    { title: 'Market position source', detail: data?.inventory.source ?? 'Awaiting market and wallet configuration', Icon: BarChart3, tone: data?.inventory.yesShares !== null ? 'teal' : 'slate' },
  ] as const;
  return <section id="event-log" className="panel rounded-xl p-5"><SectionHeader eyebrow="audit trail / data bridge" title="Live feed status" action={<Badge tone={data?.ready ? 'teal' : 'amber'}>{data?.ready ? 'synchronised' : 'waiting'}</Badge>} /><div className="divide-y divide-[#e6e8e3]">{events.map(({ title, detail, Icon, tone }) => <div key={title} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"><div className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full ${tone === 'teal' ? 'bg-[#d9f2e9] text-[#16826c]' : tone === 'amber' ? 'bg-[#fff0cc] text-[#a26908]' : 'bg-[#e8ebe7] text-[#65736f]'}`}><Icon size={13} /></div><div className="min-w-0 flex-1"><div className="text-[11px] font-bold text-[#34474a]">{title}</div><div className="mt-0.5 truncate text-[10px] text-[#7d8884]">{detail}</div></div></div>)}</div></section>;
}

function Dashboard() {
  const [now, setNow] = useState(() => Date.now());
  const { data: live, isLoading: loadingLive } = useGetPolymarketLiveSnapshot({
    query: { queryKey: getGetPolymarketLiveSnapshotQueryKey(), refetchInterval: 1000, staleTime: 500 },
  });
  const { data: connection, isLoading: loadingConnection } = useGetPolymarketStatus({
    query: { queryKey: getGetPolymarketStatusQueryKey(), refetchInterval: 15_000, staleTime: 5_000 },
  });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  const wallRatio = live?.signal.topThreeImbalanceRatio;
  return <div className="grain app-shell min-h-[100dvh]"><NavRail executionState={live?.execution.state} /><TopBar data={live} /><main id="overview" className="mx-auto max-w-[1520px] px-4 pb-10 pt-5 md:ml-[224px] md:px-7 md:pt-7"><div className="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-end"><div><div className="eyebrow text-[#89938f]">SERVER-OBSERVED / {timestampLabel(live?.serverTime)} UTC</div><h2 className="mt-1 font-display text-[23px] font-semibold tracking-[-.045em] text-[#24343a]">BTC dual-track execution monitor</h2></div><div className="flex items-center gap-2 text-[10px] text-[#7d8884]"><Activity size={13} /><span>{loadingLive ? 'Fetching live snapshot' : `snapshot ${live?.sequence ?? '—'}`}</span><span className={`h-1.5 w-1.5 rounded-full ${live?.ready ? 'bg-[#16826c] live-pulse' : 'bg-[#b9811f]'}`} /></div></div><div className="appear"><StatusHero data={live} now={now} /></div><div className="appear-2 mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><MetricCard label="Binance wall" value={wallRatio === null || wallRatio === undefined ? '—' : `${wallRatio.toFixed(2)}×`} sub="top-three depth · trigger ≥4×" Icon={Target} tone={(wallRatio ?? 0) >= 4 ? 'teal' : 'amber'} /><MetricCard label="BTC perpetual" value={formatUsd(live?.spot.priceUsd, 0)} sub="depth5 + aggregate trades" Icon={TrendingUp} tone="teal" trend={live?.signal.btcDirection === 'DOWN' ? 'down' : 'up'} /><MetricCard label="Selected side" value={live?.signal.selectedDirection ?? 'WAIT'} sub={live?.signal.confirmed ? '>10 BTC flow confirmed' : 'waiting for 50ms confirmation'} Icon={Layers3} tone={live?.signal.confirmed ? 'teal' : 'amber'} /><MetricCard label="Net inventory" value={formatSigned(live?.inventory.netShares, 2)} sub={live?.inventory.source ?? 'awaiting source'} Icon={BarChart3} tone="teal" /></div><div className="appear-3 mt-5 grid gap-5 xl:grid-cols-[minmax(0,1.48fr)_minmax(340px,.92fr)]"><div className="space-y-5"><MarketPanel data={live} /><SpotPanel data={live} now={now} /><DirectionPanel data={live} /><LiveEvents data={live} /></div><div className="space-y-5"><ExecutionPanel data={live} /><RiskPanel data={live} /><InventoryPanel data={live} /><ProxyPanel data={live} loading={loadingConnection || !connection} /></div></div><footer className="mt-8 flex flex-col justify-between gap-2 border-t border-[#dbded9] pt-4 text-[10px] text-[#8a9591] sm:flex-row"><span className="flex items-center gap-1.5"><ShieldCheck size={12} />BINANCE 4× WALL + &gt;10 BTC / 50MS · FAK ENTRY · OPPOSITE GTC DEFENSE · MUTUALLY EXCLUSIVE A/B/C</span><span className="font-mono">manual arm after every process restart</span></footer></main></div>;
}

function Router() {
  return <Switch><Route path="/" component={Dashboard} /><Route component={NotFound} /></Switch>;
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}><RoutedErrorBoundary><Router /></RoutedErrorBoundary></WouterRouter><Toaster /></TooltipProvider></QueryClientProvider>;
}

export default App;