"use client";
import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import useSWR from "swr";
import { useAuth } from "@/context/AuthContext";
import { authFetcher, authFetch } from "@/lib/authFetch";
import { PLANS, PLAN_ORDER, type PlanName, type BillingCadence } from "@/lib/plans";
import { usePortfolio } from "@/hooks/usePortfolio";
import { useAppearance } from "@/components/providers/AppearanceProvider";
import type { Accent } from "@/lib/appearance";
import ConnectBrokerageButton from "@/components/portfolio/ConnectBrokerageButton";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from "recharts";
import { axisProps, gridProps, ChartTooltip } from "@/lib/chartTheme";
import { FORMAT_PRESETS, sanitizeFormats, type FormatKey } from "@/lib/templates";
import type { Template } from "@/types/chat";

interface UserData {
  uid: string;
  name: string | null;
  email: string | null;
  photoURL: string | null;
  createdAt: string | null;
  plan: string;
  planSource?: string;
  subscriptionStatus?: string | null;
  trialEndsAt?: string | null;
  currentPeriodEnd?: string | null;
  cancelAtPeriodEnd?: boolean;
  capabilities?: Record<string, boolean>;
  allowDataTraining: boolean;
  locationMetadata: boolean;
  allowInvestorDNA: boolean;
  notifyWeeklyBriefing?: boolean;
  notifyProductUpdates?: boolean;
  stats: { conversations: number; briefings: number };
}

// ─── Icons (inline 24×24 stroke paths) ────────────────────────────────────────

const ICON_PATHS: Record<string, string> = {
  general:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  account: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  card: '<rect x="1" y="4" width="22" height="16" rx="2.5"/><line x1="1" y1="10" x2="23" y2="10"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
  globe: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  contrast: '<circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 0 0 20z" fill="currentColor"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  download:
    '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  trash:
    '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  templates:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
};

function Icon({
  name,
  size = 16,
  stroke = 2,
  style,
}: {
  name: string;
  size?: number;
  stroke?: number;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      dangerouslySetInnerHTML={{ __html: ICON_PATHS[name] }}
    />
  );
}

// ─── Navigation ───────────────────────────────────────────────────────────────

const NAV = [
  {
    grp: "Workspace",
    items: [
      { id: "general", label: "General", icon: "general" },
      { id: "templates", label: "Templates", icon: "templates" },
      { id: "appearance", label: "Appearance", icon: "contrast" },
      { id: "notifications", label: "Notifications", icon: "bell" },
      { id: "connections", label: "Connections", icon: "link" },
    ],
  },
  {
    grp: "Account",
    items: [
      { id: "account", label: "Profile", icon: "account" },
      { id: "privacy", label: "Privacy & Data", icon: "shield" },
      { id: "billing", label: "Billing", icon: "card" },
      { id: "usage", label: "Usage", icon: "activity" },
    ],
  },
] as const;

type SectionId = (typeof NAV)[number]["items"][number]["id"];

// ─── Shared primitives ────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-[22px] w-[40px] flex-shrink-0 items-center rounded-full transition-colors duration-200"
      style={{ background: checked ? "var(--color-accent)" : "var(--color-border-strong)" }}
    >
      <span
        className="inline-block h-[16px] w-[16px] transform rounded-full transition-transform duration-200"
        style={{
          background: "var(--color-on-accent)",
          boxShadow: "var(--shadow-card)",
          transform: checked ? "translateX(21px)" : "translateX(3px)",
        }}
      />
    </button>
  );
}

type BtnVariant = "soft" | "prim" | "danger";
function Btn({
  variant = "soft",
  onClick,
  disabled,
  children,
}: {
  variant?: BtnVariant;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const classes: Record<BtnVariant, string> = {
    soft: "btn",
    prim: "btn btn-primary",
    danger: "btn btn-danger",
  };
  return (
    <button onClick={onClick} disabled={disabled} className={classes[variant]}>
      {children}
    </button>
  );
}

function Row({
  label,
  description,
  danger,
  children,
}: {
  label: string;
  description?: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-start justify-between gap-6 py-4"
      style={{ borderBottom: "1px solid var(--color-border)" }}
    >
      <div className="min-w-0">
        <p className="text-[length:var(--text-sm)] font-semibold" style={{ color: danger ? "var(--color-bear)" : "var(--color-text)" }}>
          {label}
        </p>
        {description && (
          <p
            className="text-[length:var(--text-sm)] mt-[3px] leading-relaxed"
            style={{ color: "var(--color-text-secondary)", maxWidth: "42ch" }}
          >
            {description}
          </p>
        )}
      </div>
      <div className="flex-shrink-0 flex items-center">{children}</div>
    </div>
  );
}

function Head({ title, description }: { title: string; description?: string }) {
  return (
    <div>
      <div className="mb-2">
        <h2 className="serif text-[length:var(--text-xl)] font-bold tracking-[-0.01em]" style={{ color: "var(--color-text)" }}>
          {title}
        </h2>
        {description && (
          <p className="text-[length:var(--text-sm)] mt-[5px] leading-relaxed" style={{ color: "var(--color-text-secondary)" }}>
            {description}
          </p>
        )}
      </div>
      <div style={{ height: 1, background: "var(--color-border)", margin: "18px 0 6px" }} />
    </div>
  );
}

// ─── Sections ─────────────────────────────────────────────────────────────────

/** Pill segmented control used across the Appearance section. */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { v: T; label: string; icon?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      className="inline-flex gap-[3px] p-[3px] rounded-[var(--radius-sm)]"
      style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
    >
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className="inline-flex items-center gap-1.5 px-3 py-[5px] text-[length:var(--text-sm)] font-medium rounded-[var(--radius-sm)] transition-all duration-150"
          style={
            value === o.v
              ? {
                  background: "var(--color-bg)",
                  color: "var(--color-accent)",
                  boxShadow: "var(--shadow-card)",
                  fontWeight: 600,
                }
              : { color: "var(--color-text-secondary)" }
          }
        >
          {o.icon && <Icon name={o.icon} size={13} />} {o.label}
        </button>
      ))}
    </div>
  );
}

const ACCENTS: { v: Accent; color: string; label: string }[] = [
  { v: "navy", color: "#1a4b8f", label: "Navy" },
  { v: "emerald", color: "#057a55", label: "Emerald" },
  { v: "violet", color: "#7c3aed", label: "Violet" },
  { v: "crimson", color: "#b42318", label: "Crimson" },
  { v: "teal", color: "#0d9488", label: "Teal" },
];

function AppearanceSection() {
  const { prefs, set, reset } = useAppearance();
  return (
    <div>
      <Head title="Appearance" description="Personalize how Finava looks. These preferences sync to your account." />

      <Row label="Theme" description="Light, dark, or match your system automatically.">
        <Segmented
          value={prefs.theme}
          onChange={(v) => set("theme", v)}
          options={[
            { v: "light", label: "Light", icon: "sun" },
            { v: "dark", label: "Dark", icon: "moon" },
            { v: "system", label: "System", icon: "monitor" },
          ]}
        />
      </Row>

      <Row label="Accent color" description="The highlight color used across buttons, links, and charts.">
        <div className="flex items-center gap-2.5">
          {ACCENTS.map((a) => {
            const on = prefs.accent === a.v;
            return (
              <button
                key={a.v}
                onClick={() => set("accent", a.v)}
                aria-label={a.label}
                aria-pressed={on}
                title={a.label}
                className="rounded-full transition-transform duration-150"
                style={{
                  width: 22,
                  height: 22,
                  background: a.color,
                  border: `2px solid ${on ? "var(--color-bg)" : "transparent"}`,
                  boxShadow: on
                    ? "0 0 0 2px var(--color-text)"
                    : "0 0 0 1px var(--color-border-strong)",
                  transform: on ? "scale(1.08)" : "scale(1)",
                }}
              />
            );
          })}
        </div>
      </Row>

      <Row label="Text size" description="Scales text across the whole app.">
        <Segmented
          value={prefs.textSize}
          onChange={(v) => set("textSize", v)}
          options={[
            { v: "small", label: "Small" },
            { v: "default", label: "Default" },
            { v: "large", label: "Large" },
          ]}
        />
      </Row>

      <Row label="Interface density" description="Comfortable spacing, or compact to fit more on screen.">
        <Segmented
          value={prefs.density}
          onChange={(v) => set("density", v)}
          options={[
            { v: "comfortable", label: "Comfortable" },
            { v: "compact", label: "Compact" },
          ]}
        />
      </Row>

      <Row label="Reduce motion" description="Tone down animations and transitions across the app.">
        <Toggle checked={prefs.reduceMotion} onChange={(v) => set("reduceMotion", v)} />
      </Row>

      <Row
        label="Editorial headings"
        description="Use the Playfair serif for large headings. Off keeps everything in the sans typeface."
      >
        <Toggle checked={prefs.serifHeadings} onChange={(v) => set("serifHeadings", v)} />
      </Row>

      <div className="mt-6 flex justify-end">
        <Btn variant="soft" onClick={reset}>
          Reset to defaults
        </Btn>
      </div>
    </div>
  );
}

function GeneralSection() {
  const { devEnabled, devBypass, toggleDevBypass } = useAuth();
  return (
    <div>
      <Head title="General" description="App-wide preferences." />
      {devEnabled && (
        <Row
          label="Developer preview mode"
          description="Preview the app as a signed-in Pro user without logging in. Local development only."
        >
          <div className="flex items-center gap-2.5">
            <span
              className="text-[length:var(--text-meta)] font-semibold tabular-nums"
              style={{ color: devBypass ? "var(--color-accent)" : "var(--color-muted)" }}
            >
              {devBypass ? "On" : "Off"}
            </span>
            <Toggle checked={devBypass} onChange={toggleDevBypass} />
          </div>
        </Row>
      )}
    </div>
  );
}

// Only the notifications Finava can actually send are offered here. Price and
// signal alerts, run summaries and a separate email switch were toggles backed
// by nothing — no persistence and no delivery — so they are gone until the
// delivery path behind them exists.
function NotificationsSection({ userData, mutate }: { userData: UserData | undefined; mutate: () => void }) {
  async function patch(key: string, value: boolean) {
    await authFetch("/api/user", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });
    mutate();
  }

  return (
    <div>
      <Head title="Notifications" description="Decide what Finava emails you about." />
      <Row
        label="Weekly briefing"
        description="Email your Monday briefing when it is generated."
      >
        <Toggle
          checked={userData?.notifyWeeklyBriefing ?? true}
          onChange={(v) => patch("notifyWeeklyBriefing", v)}
        />
      </Row>
      <Row
        label="Product updates"
        description="Occasional news about new Finava features."
      >
        <Toggle
          checked={userData?.notifyProductUpdates ?? false}
          onChange={(v) => patch("notifyProductUpdates", v)}
        />
      </Row>
    </div>
  );
}

function ConnectionRow({
  logo,
  color,
  fg,
  border,
  name,
  status,
  live,
  children,
}: {
  logo: string;
  color: string;
  fg: string;
  border?: boolean;
  name: string;
  status: string;
  live: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex items-center gap-3 py-[14px]"
      style={{ borderBottom: "1px solid var(--color-border)" }}
    >
      <div
        className="w-10 h-10 rounded-[var(--radius-md)] flex items-center justify-center font-extrabold text-[length:var(--text-sm)] flex-shrink-0"
        style={{ background: color, color: fg, border: `1px solid ${border ? "var(--color-border-strong)" : "transparent"}` }}
      >
        {logo}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[length:var(--text-sm)] font-semibold" style={{ color: "var(--color-text)" }}>
          {name}
        </div>
        <div className="text-[length:var(--text-sm)] mt-[2px] flex items-center gap-1.5" style={{ color: "var(--color-text-secondary)" }}>
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: live ? "var(--color-bull)" : "var(--color-muted)" }} />
          {status}
        </div>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function PlaidRow() {
  const { plaidConnected, plaidInstitutions, disconnectPlaid, refresh } = usePortfolio();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const inst = plaidInstitutions[0];

  async function handleDisconnect() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    setBusy(true);
    try {
      await disconnectPlaid();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const status = plaidConnected
    ? `Connected · ${inst?.name ?? "Brokerage"}${inst?.lastSyncedAt ? ` · synced ${new Date(inst.lastSyncedAt).toLocaleDateString()}` : ""}`
    : "Not connected";

  return (
    <ConnectionRow logo="◉" color="#111c2e" fg="#fff" name="Plaid" status={status} live={plaidConnected}>
      {plaidConnected ? (
        <Btn variant={confirming ? "danger" : "soft"} onClick={handleDisconnect} disabled={busy}>
          {busy ? "Disconnecting…" : confirming ? "Confirm disconnect" : "Disconnect"}
        </Btn>
      ) : (
        <ConnectBrokerageButton className="btn btn-primary" label="Connect" onLinked={refresh} />
      )}
    </ConnectionRow>
  );
}

function ConnectionsSection({ userData }: { userData: UserData | undefined }) {
  return (
    <div>
      <Head title="Connections" description="Brokerages and services linked to your Finava account." />
      <ConnectionRow logo="AL" color="#ffd400" fg="#0d1626" name="Alpaca" status="Connected · Paper trading" live>
        <Btn variant="soft">Manage</Btn>
      </ConnectionRow>
      <ConnectionRow
        logo="G"
        color="#fff"
        fg="#1a4b8f"
        border
        name="Google"
        status={userData?.email ? `Linked · ${userData.email}` : "Linked"}
        live
      >
        <Btn variant="soft">Manage</Btn>
      </ConnectionRow>
      <PlaidRow />
      {/* When connected, manual portfolio entry is disabled — Plaid is the source of truth. */}
      <p className="text-[length:var(--text-meta)] mt-3 leading-relaxed" style={{ color: "var(--color-muted)" }}>
        Connecting a brokerage replaces your portfolio with the synced holdings and turns off
        manual entry. Disconnecting keeps those holdings as editable manual positions.
      </p>
    </div>
  );
}

/** Wireframe-skeleton thumbnail for a response format — abstract bars/lines that
 *  hint at the output shape, so users pick a format by sight not by reading. */
function FormatThumb({ k }: { k: FormatKey }) {
  const line = "var(--color-border-strong)";
  const faint = "var(--color-border)";
  const common = { viewBox: "0 0 120 64", width: "100%", height: "auto", "aria-hidden": true } as const;
  switch (k) {
    case "brief":
      return (
        <svg {...common}>
          <rect x="10" y="20" width="100" height="6" rx="3" fill={line} />
          <rect x="10" y="32" width="84" height="6" rx="3" fill={line} />
          <rect x="10" y="44" width="58" height="6" rx="3" fill={faint} />
        </svg>
      );
    case "bulleted":
      return (
        <svg {...common}>
          <circle cx="14" cy="20" r="3" fill={line} /><rect x="24" y="17" width="84" height="6" rx="3" fill={line} />
          <circle cx="14" cy="34" r="3" fill={line} /><rect x="24" y="31" width="72" height="6" rx="3" fill={line} />
          <circle cx="14" cy="48" r="3" fill={line} /><rect x="24" y="45" width="80" height="6" rx="3" fill={line} />
        </svg>
      );
    case "deep_memo":
      return (
        <svg {...common}>
          <rect x="10" y="12" width="46" height="7" rx="3" fill={line} />
          <rect x="10" y="24" width="100" height="5" rx="2" fill={faint} />
          <rect x="10" y="33" width="92" height="5" rx="2" fill={faint} />
          <rect x="10" y="46" width="40" height="7" rx="3" fill={line} />
          <rect x="62" y="47" width="48" height="5" rx="2" fill={faint} />
        </svg>
      );
    case "table":
      return (
        <svg {...common}>
          <rect x="10" y="14" width="100" height="36" rx="3" fill="none" stroke={line} strokeWidth="1.5" />
          <line x1="10" y1="26" x2="110" y2="26" stroke={line} strokeWidth="1" />
          <line x1="10" y1="38" x2="110" y2="38" stroke={faint} strokeWidth="1" />
          <line x1="43" y1="14" x2="43" y2="50" stroke={faint} strokeWidth="1" />
          <line x1="77" y1="14" x2="77" y2="50" stroke={faint} strokeWidth="1" />
        </svg>
      );
    case "verdict_first":
      return (
        <svg {...common}>
          <rect x="10" y="13" width="64" height="12" rx="4" fill={line} />
          <rect x="10" y="33" width="100" height="5" rx="2" fill={faint} />
          <rect x="10" y="42" width="92" height="5" rx="2" fill={faint} />
          <rect x="10" y="51" width="70" height="5" rx="2" fill={faint} />
        </svg>
      );
    case "chart_led":
      return (
        <svg {...common}>
          <rect x="14" y="34" width="14" height="18" rx="2" fill={faint} />
          <rect x="34" y="24" width="14" height="28" rx="2" fill={faint} />
          <rect x="54" y="30" width="14" height="22" rx="2" fill={faint} />
          <rect x="74" y="16" width="14" height="36" rx="2" fill={line} />
          <line x1="10" y1="52" x2="108" y2="52" stroke={line} strokeWidth="1" />
        </svg>
      );
  }
}

interface Draft {
  id?: string;
  title: string;
  instructions: string;
  formats: FormatKey[];
}

function TemplatesSection() {
  const { data: templates, mutate } = useSWR<Template[]>("/api/playbooks", authFetcher);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  function openNew() {
    setDraft({ title: "", instructions: "", formats: [] });
  }
  function openEdit(t: Template) {
    setDraft({ id: t.id, title: t.title ?? "", instructions: t.instructions ?? "", formats: sanitizeFormats(t.formats) });
  }
  function toggleFormat(k: FormatKey) {
    setDraft((d) => (d ? { ...d, formats: d.formats.includes(k) ? d.formats.filter((x) => x !== k) : [...d.formats, k] } : d));
  }

  async function save() {
    if (!draft || !draft.title.trim()) return;
    setSaving(true);
    try {
      const payload = { title: draft.title.trim(), instructions: draft.instructions.trim(), formats: draft.formats };
      const url = draft.id ? `/api/playbooks/${draft.id}` : "/api/playbooks";
      const method = draft.id ? "PATCH" : "POST";
      const res = await authFetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await mutate();
      setDraft(null);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    await authFetch(`/api/playbooks/${id}`, { method: "DELETE" });
    await mutate();
    setDraft(null);
  }

  const list = Array.isArray(templates) ? templates : [];

  return (
    <div>
      <Head title="Templates" description="Saved ways for Finava to respond. Pick one in the composer to shape any answer — tone, structure, and what to always include." />

      <div className="grid mt-2" style={{ gridTemplateColumns: "minmax(0,1fr) 248px" }}>
        {/* Main pane — editor or empty state */}
        <div className="pr-7">
          {draft ? (
            <div>
              <label className="block text-[length:var(--text-sm)] mb-1.5" style={{ color: "var(--color-text-secondary)" }}>Name</label>
              <input
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                maxLength={80}
                placeholder="e.g. Earnings deep-dive"
                className="input mb-4"
              />

              <label className="block text-[length:var(--text-sm)] mb-1.5" style={{ color: "var(--color-text-secondary)" }}>
                Instructions <span style={{ color: "var(--color-muted)" }}>— how Finava should respond</span>
              </label>
              <textarea
                value={draft.instructions}
                onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                maxLength={2000}
                rows={3}
                placeholder="Lead with the bottom line, always quantify the key numbers, and end with the biggest risk to watch."
                className="input resize-none mb-5 leading-relaxed"
              />

              <label className="block text-[length:var(--text-sm)] mb-2" style={{ color: "var(--color-text-secondary)" }}>
                Format <span style={{ color: "var(--color-muted)" }}>— combine a few, or let Finava choose</span>
              </label>

              <button
                type="button"
                onClick={() => setDraft({ ...draft, formats: [] })}
                className="w-full flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2.5 mb-2.5 text-left transition-colors duration-100"
                style={{
                  background: "var(--color-bg)",
                  border: `${draft.formats.length === 0 ? 2 : 1}px solid ${draft.formats.length === 0 ? "var(--color-accent)" : "var(--color-border)"}`,
                }}
              >
                <span
                  className="w-9 h-9 rounded-[var(--radius-sm)] flex items-center justify-center flex-shrink-0"
                  style={{ background: "var(--color-accent-light)", color: "var(--color-accent)" }}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 3v4M3 5h4M6 17v4M4 19h4M13 3l2.5 6.5L22 12l-6.5 2.5L13 21l-2.5-6.5L4 12l6.5-2.5L13 3z" />
                  </svg>
                </span>
                <span>
                  <span className="block text-[length:var(--text-sm)] font-semibold" style={{ color: "var(--color-text)" }}>Auto</span>
                  <span className="block text-[length:var(--text-meta)]" style={{ color: "var(--color-text-secondary)" }}>Finava picks the best structure for each question</span>
                </span>
              </button>

              <div className="grid grid-cols-3 md:grid-cols-6 gap-2.5 mb-5">
                {FORMAT_PRESETS.map((p) => {
                  const on = draft.formats.includes(p.key);
                  return (
                    <button
                      key={p.key}
                      type="button"
                      onClick={() => toggleFormat(p.key)}
                      className="relative rounded-[var(--radius-md)] px-2 pt-2.5 pb-1.5 transition-colors duration-100"
                      style={{
                        background: "var(--color-bg)",
                        border: `${on ? 2 : 1}px solid ${on ? "var(--color-accent)" : "var(--color-border)"}`,
                      }}
                    >
                      {on && (
                        <span
                          className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full flex items-center justify-center"
                          style={{ background: "var(--color-accent)", color: "var(--color-on-accent)" }}
                        >
                          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        </span>
                      )}
                      <FormatThumb k={p.key} />
                      <p className="text-[length:var(--text-meta)] font-medium text-center mt-2 leading-tight" style={{ color: on ? "var(--color-accent)" : "var(--color-text-secondary)" }}>
                        {p.label}
                      </p>
                    </button>
                  );
                })}
              </div>

              <div className="flex items-center justify-between pt-3.5" style={{ borderTop: "1px solid var(--color-border)" }}>
                <div>
                  {draft.id && (
                    <Btn variant="danger" onClick={() => remove(draft.id!)}>
                      <Icon name="trash" size={14} /> Delete
                    </Btn>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Btn variant="soft" onClick={() => setDraft(null)}>Cancel</Btn>
                  <Btn variant="prim" onClick={save} disabled={saving || !draft.title.trim()}>
                    {saving ? "Saving…" : "Save template"}
                  </Btn>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center text-center" style={{ minHeight: 340 }}>
              <div
                className="w-12 h-12 rounded-[var(--radius-md)] flex items-center justify-center mb-3.5"
                style={{ background: "var(--color-accent-light)", color: "var(--color-accent)" }}
              >
                <Icon name="templates" size={22} />
              </div>
              <p className="text-[length:var(--text-body)] font-semibold" style={{ color: "var(--color-text)" }}>
                {list.length > 0 ? "Select a template to edit" : "Create your first template"}
              </p>
              <p className="text-[length:var(--text-sm)] mt-1 mb-4 max-w-[34ch]" style={{ color: "var(--color-text-secondary)" }}>
                Templates shape how Finava answers — tone, structure, and what to always include.
              </p>
              <Btn variant="prim" onClick={openNew}>
                <Icon name="plus" size={14} /> New template
              </Btn>
            </div>
          )}
        </div>

        {/* Right rail — your saved templates */}
        <div style={{ borderLeft: "1px solid var(--color-border)", paddingLeft: 18 }}>
          <div className="flex items-center justify-between mb-2.5">
            <span className="eyebrow-label" style={{ letterSpacing: "0.14em", color: "var(--color-muted)" }}>
              Your templates
            </span>
            <button
              onClick={openNew}
              aria-label="New template"
              className="w-6 h-6 rounded-[var(--radius-sm)] flex items-center justify-center transition-colors duration-100"
              style={{ color: "var(--color-text-secondary)", background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
            >
              <Icon name="plus" size={13} />
            </button>
          </div>

          {list.length === 0 ? (
            <p className="text-[length:var(--text-sm)] py-2" style={{ color: "var(--color-muted)" }}>
              No templates yet.
            </p>
          ) : (
            <div className="flex flex-col gap-0.5">
              {list.map((t) => {
                const fmts = sanitizeFormats(t.formats);
                const sub = fmts.length === 0 ? "Auto" : fmts.map((f) => FORMAT_PRESETS.find((p) => p.key === f)?.label ?? f).join(" · ");
                const isOpen = draft?.id === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => openEdit(t)}
                    className="text-left rounded-[var(--radius-md)] px-2.5 py-2 transition-colors duration-100"
                    style={isOpen ? { background: "var(--color-accent-light)" } : undefined}
                  >
                    <p className="text-[length:var(--text-sm)] font-medium truncate" style={{ color: isOpen ? "var(--color-accent)" : "var(--color-text)" }}>{t.title}</p>
                    <p className="text-[length:var(--text-meta)] mt-[1px] truncate" style={{ color: "var(--color-muted)" }}>{sub}</p>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProfileSection({ userData, mutate }: { userData: UserData | undefined; mutate: () => void }) {
  const { signOut } = useAuth();
  const [name, setName] = useState(userData?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Sync the editable field when the fetched profile name arrives/changes
  // (render-phase reset, no effect).
  const [prevName, setPrevName] = useState(userData?.name);
  if (userData?.name !== prevName) {
    setPrevName(userData?.name);
    if (userData?.name) setName(userData.name);
  }

  async function saveName() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await authFetch("/api/user", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name.trim() }),
      });
      mutate();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  const initials = (userData?.name ?? userData?.email ?? "?")
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const memberSince = userData?.createdAt
    ? new Date(userData.createdAt).toLocaleDateString("en-US", { month: "long", year: "numeric" })
    : "—";

  return (
    <div>
      <Head title="Profile" description="Manage your personal information." />
      <div className="flex items-center gap-4" style={{ padding: "8px 0 22px" }}>
        {userData?.photoURL ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={userData.photoURL}
            alt={userData.name ?? ""}
            className="w-[60px] h-[60px] rounded-full object-cover flex-shrink-0"
            style={{ border: "1px solid var(--color-accent-medium)" }}
          />
        ) : (
          <div
            className="w-[60px] h-[60px] rounded-full flex items-center justify-center text-[length:var(--text-display)] font-bold flex-shrink-0"
            style={{
              background: "var(--color-accent-light)",
              color: "var(--color-accent)",
              border: "1px solid var(--color-accent-medium)",
            }}
          >
            {initials}
          </div>
        )}
        <div>
          <div className="text-[length:var(--text-lg)] font-bold" style={{ color: "var(--color-text)" }}>
            {userData?.name ?? "—"}
          </div>
          <div className="text-[length:var(--text-sm)] mt-[1px]" style={{ color: "var(--color-text-secondary)" }}>
            {userData?.email ?? "—"}
          </div>
          <div className="text-[length:var(--text-meta)] mt-1" style={{ color: "var(--color-muted)" }}>
            Member since {memberSince}
          </div>
        </div>
      </div>

      <Row label="Display name" description="How your name appears across the app.">
        <div className="flex items-center gap-2">
          {saved && (
            <span className="text-[length:var(--text-sm)] font-semibold" style={{ color: "var(--color-bull)" }}>
              Saved
            </span>
          )}
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
            onKeyDown={(e) => e.key === "Enter" && saveName()}
            className="input"
            style={{ width: 170 }}
          />
          <Btn variant="prim" onClick={saveName} disabled={saving || !name.trim()}>
            {saving ? "Saving…" : "Save"}
          </Btn>
        </div>
      </Row>

      <Row label="Email" description="Your login email. Managed by Google.">
        <span className="text-[length:var(--text-sm)]" style={{ color: "var(--color-text-secondary)" }}>
          {userData?.email ?? "—"}
        </span>
      </Row>

      <Row label="Sign out" description="Sign out of Finava on this device.">
        <Btn variant="soft" onClick={signOut}>
          <Icon name="logout" size={14} /> Sign out
        </Btn>
      </Row>
    </div>
  );
}

function PrivacySection({ userData, mutate }: { userData: UserData | undefined; mutate: () => void }) {
  const { signOut } = useAuth();
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [privacyError, setPrivacyError] = useState("");

  async function patch(key: string, value: boolean) {
    await authFetch("/api/user", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [key]: value }),
    });
    mutate();
  }

  async function exportData() {
    setExporting(true);
    setPrivacyError("");
    try {
      const res = await authFetch("/api/user/export");
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `finava-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setPrivacyError("Export failed. Please try again.");
    } finally {
      setExporting(false);
    }
  }

  async function deleteAccount() {
    const confirmed = window.confirm(
      "Permanently delete your Finava account?\n\nThis deletes your conversations, watchlists, portfolio data, and brokerage connections, and cancels any subscription. This cannot be undone."
    );
    if (!confirmed) return;
    setDeleting(true);
    setPrivacyError("");
    try {
      const res = await authFetch("/api/user/delete", { method: "POST" });
      if (!res.ok) throw new Error("Delete failed");
      await signOut();
    } catch {
      setPrivacyError("Account deletion failed. Please try again or contact hello@finava.ai.");
      setDeleting(false);
    }
  }

  return (
    <div>
      <Head title="Privacy & Data" description="Control how Finava uses and stores your data." />
      <Row
        label="Help improve Finava"
        description="Allow your chats and sessions to improve AI models. You can opt out at any time."
      >
        <Toggle checked={userData?.allowDataTraining ?? true} onChange={(v) => patch("allowDataTraining", v)} />
      </Row>
      <Row label="Location metadata" description="Use coarse location (city/region) to improve market context.">
        <Toggle checked={userData?.locationMetadata ?? true} onChange={(v) => patch("locationMetadata", v)} />
      </Row>
      <Row
        label="Investor DNA"
        description="Let Finava learn how you invest from your holdings to personalize your research. Off hides your DNA and the per-stock Lens."
      >
        <Toggle checked={userData?.allowInvestorDNA ?? true} onChange={(v) => patch("allowInvestorDNA", v)} />
      </Row>
      <Row label="Export data" description="Download a copy of your conversations, portfolio, and preferences.">
        <Btn variant="soft" onClick={exportData} disabled={exporting}>
          <Icon name="download" size={14} /> {exporting ? "Exporting…" : "Export"}
        </Btn>
      </Row>
      <Row
        label="Delete account"
        description="Permanently delete your account and all associated data. This cannot be undone."
        danger
      >
        <Btn variant="danger" onClick={deleteAccount} disabled={deleting}>
          <Icon name="trash" size={14} /> {deleting ? "Deleting…" : "Delete account"}
        </Btn>
      </Row>
      {privacyError && (
        <p style={{ marginTop: 10, fontSize: "var(--text-sm)", color: "var(--color-bear)" }}>{privacyError}</p>
      )}
    </div>
  );
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function daysLeft(iso: string | null | undefined): number {
  if (!iso) return 0;
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
}

/** A short human feature list derived from the plan config. */
function planFeatures(plan: PlanName): string[] {
  const c = PLANS[plan];
  const dr =
    c.deepResearchPerMonth === Infinity
      ? "Unlimited Deep Research"
      : `${c.deepResearchPerMonth} Deep Research / mo`;
  // Credits are the limit that actually binds day to day, so lead with them —
  // the meter in Settings → Usage counts the same unit.
  const feats = [`${c.monthly.toLocaleString()} credits / mo`, dr];
  if (c.capabilities.plaidLinking) feats.push("Live brokerage sync");
  if (c.capabilities.weeklyBriefings) feats.push("Weekly AI briefings");
  feats.push(
    c.watchlistLimit === Infinity ? "Unlimited watchlists" : `${c.watchlistLimit} watchlist`
  );
  return feats;
}

function BillingSection({ userData, mutate }: { userData: UserData | undefined; mutate: () => void }) {
  const plan = (userData?.plan as PlanName) ?? "Free";
  const source = userData?.planSource;
  const status = userData?.subscriptionStatus;
  const isSubscribed = !!status && ["active", "trialing", "past_due"].includes(status);

  const [cadence, setCadence] = useState<BillingCadence>("monthly");
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [changed, setChanged] = useState<string | null>(null);

  async function startCheckout(target: PlanName) {
    setBusy(target);
    try {
      const res = await authFetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: target, cadence }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        window.location.href = data.url as string;
        return;
      }
      alert(data.error === "plan_not_purchasable"
        ? "That plan isn't available yet."
        : "Could not start checkout. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  async function changePlan(target: PlanName) {
    setBusy(target);
    try {
      const res = await authFetch("/api/stripe/change-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: target, cadence }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 404 && data.error === "no_subscription") {
        await startCheckout(target);
        return;
      }
      if (!res.ok) {
        alert(data.error || "Could not update plan. Please try again.");
        return;
      }
      setPicking(false);
      setChanged(target);
      // Webhook updates Firestore — poll a few times to pick up the change.
      mutate();
      setTimeout(() => mutate(), 2000);
      setTimeout(() => { mutate(); setChanged(null); }, 5000);
    } finally {
      setBusy(null);
    }
  }

  async function openPortal() {
    setBusy("portal");
    try {
      const res = await authFetch("/api/stripe/portal", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.url) {
        window.location.href = data.url as string;
        return;
      }
      if (res.status === 404) setPicking(true);
      else alert("Could not open the billing portal. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  let statusLine: string;
  if (source === "trial") {
    statusLine = `Trial — ${daysLeft(userData?.trialEndsAt)} day${daysLeft(userData?.trialEndsAt) === 1 ? "" : "s"} left · then Free`;
  } else if (isSubscribed && userData?.currentPeriodEnd) {
    statusLine = userData?.cancelAtPeriodEnd
      ? `Cancels ${fmtDate(userData.currentPeriodEnd)}`
      : `Renews ${fmtDate(userData.currentPeriodEnd)}`;
  } else if (plan === "Free") {
    statusLine = "Free plan";
  } else {
    statusLine = PLANS[plan].price.monthly + "/mo";
  }

  const purchasable = PLAN_ORDER.filter((p) => PLANS[p].stripe.purchasable);
  const planIdx = PLAN_ORDER.indexOf(plan);

  return (
    <div>
      <Head title="Billing" description="Your subscription and payment details." />

      {/* Plan changed banner */}
      {changed && (
        <div
          className="mb-5 rounded-[var(--radius-md)] px-4 py-3 text-[length:var(--text-sm)] flex items-center justify-between"
          style={{ border: "1px solid var(--color-bull)", background: "var(--color-surface)", color: "var(--color-text)" }}
        >
          <span>Switching to Finava {changed} — updating your plan…</span>
          <button onClick={() => setChanged(null)} className="text-[length:var(--text-sm)] font-semibold" style={{ color: "var(--color-text-secondary)" }}>
            Dismiss
          </button>
        </div>
      )}

      {/* Current plan card */}
      <div
        style={{
          border: "1px solid var(--color-accent-medium)",
          borderRadius: "var(--radius-md)",
          padding: 20,
          background: "var(--color-accent-light)",
          marginBottom: 22,
        }}
      >
        <div className="flex justify-between items-start">
          <div>
            <div className="eyebrow-label" style={{ color: "var(--color-accent)", letterSpacing: "0.18em" }}>
              Current plan
            </div>
            <div className="mt-1.5 text-[length:var(--text-stat)] font-bold" style={{ fontFamily: "var(--font-serif)", color: "var(--color-text)" }}>
              Finava {plan}
            </div>
            <div className="text-[length:var(--text-sm)] mt-[3px]" style={{ color: "var(--color-text-secondary)" }}>
              {statusLine}
              {status === "past_due" && " · payment failed"}
            </div>
          </div>
          <span
            className="inline-flex items-center gap-1.5 px-2.5 py-[3px] rounded-full text-[length:var(--text-sm)] font-semibold uppercase"
            style={{
              background: "var(--color-accent-light)",
              color: "var(--color-accent)",
              border: "1px solid var(--color-accent-medium)",
            }}
          >
            {plan}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-5 mt-4">
          {planFeatures(plan).map((f) => (
            <div key={f} className="flex items-center gap-2 text-[length:var(--text-sm)] py-1" style={{ color: "var(--color-text-secondary)" }}>
              <span style={{ color: "var(--color-bull)" }} className="flex-shrink-0">
                <Icon name="check" size={14} />
              </span>
              {f}
            </div>
          ))}
        </div>
      </div>

      <Row label="Plan" description={isSubscribed ? "Upgrade, downgrade, or switch billing period." : "Upgrade to unlock more."}>
        {isSubscribed ? (
          <Btn variant="soft" onClick={() => setPicking(true)} disabled={busy !== null}>
            Change plan
          </Btn>
        ) : (
          <Btn variant="prim" onClick={() => setPicking(true)} disabled={busy !== null}>
            Upgrade
          </Btn>
        )}
      </Row>
      <Row label="Payment method" description="Managed securely via Stripe.">
        <Btn variant="soft" onClick={openPortal} disabled={busy !== null}>
          <Icon name="card" size={14} /> Manage billing
        </Btn>
      </Row>
      <Row label="Invoices" description="Download past receipts and invoices.">
        <Btn variant="soft" onClick={openPortal} disabled={busy !== null}>View history</Btn>
      </Row>

      {/* Plan picker modal */}
      {picking && (
        <div
          className="fixed inset-0 flex items-center justify-center"
          style={{ zIndex: 1000, background: "var(--color-scrim)", backdropFilter: "blur(4px)" }}
          onClick={() => setPicking(false)}
        >
          <div
            className="rounded-[var(--radius-xl)] p-6 w-full"
            style={{
              maxWidth: 520,
              margin: "0 16px",
              background: "var(--color-bg)",
              border: "1px solid var(--color-border)",
              boxShadow: "var(--shadow-pop)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div className="flex items-center justify-between mb-5">
              <p className="text-[length:var(--text-lg)] font-bold" style={{ color: "var(--color-text)" }}>
                {isSubscribed ? "Change plan" : "Choose a plan"}
              </p>
              <div className="flex items-center gap-3">
                <Segmented
                  value={cadence}
                  onChange={setCadence}
                  options={[
                    { v: "monthly", label: "Monthly" },
                    { v: "annual", label: "Annual · save 2 mo" },
                  ]}
                />
                <button
                  onClick={() => setPicking(false)}
                  className="rounded-[var(--radius-sm)] p-1 transition-colors duration-100"
                  style={{ color: "var(--color-text-secondary)" }}
                >
                  <Icon name="x" size={18} />
                </button>
              </div>
            </div>

            {/* Plan cards */}
            <div className="grid grid-cols-2 gap-3">
              {purchasable.map((p) => {
                const c = PLANS[p];
                const isCurrent = p === plan && isSubscribed;
                const thisIdx = PLAN_ORDER.indexOf(p);
                const isUpgrade = thisIdx > planIdx;

                let btnLabel: string;
                if (isCurrent) btnLabel = "Current plan";
                else if (busy === p) btnLabel = isSubscribed ? "Updating…" : "Redirecting…";
                else if (isSubscribed) btnLabel = isUpgrade ? `Upgrade to ${c.label}` : `Switch to ${c.label}`;
                else btnLabel = `Choose ${c.label}`;

                return (
                  <div
                    key={p}
                    className="rounded-[var(--radius-md)] p-4 flex flex-col"
                    style={{
                      border: isCurrent ? "1.5px solid var(--color-accent)" : "1px solid var(--color-border)",
                      background: isCurrent ? "var(--color-accent-light)" : "var(--color-surface)",
                    }}
                  >
                    <div className="flex items-start justify-between mb-0.5">
                      <div className="text-[length:var(--text-body)] font-bold" style={{ color: "var(--color-text)" }}>
                        Finava {c.label}
                      </div>
                      {isCurrent && (
                        <span
                          className="text-[length:var(--text-micro)] font-bold uppercase px-1.5 py-[2px] rounded-full flex-shrink-0"
                          style={{ background: "var(--color-accent)", color: "var(--color-on-accent)", letterSpacing: "0.1em" }}
                        >
                          Current
                        </span>
                      )}
                    </div>
                    <div className="text-[length:var(--text-display)] font-bold mt-1 tabular-nums" style={{ fontFamily: "var(--font-serif)", color: "var(--color-text)" }}>
                      {cadence === "monthly" ? c.price.monthly : c.price.annual}
                      <span className="text-[length:var(--text-sm)] font-normal" style={{ color: "var(--color-text-secondary)" }}>
                        {cadence === "monthly" ? " / mo" : " / yr"}
                      </span>
                    </div>
                    <div className="mt-3 mb-4 flex-1 space-y-1.5">
                      {planFeatures(p).map((f) => (
                        <div key={f} className="flex items-center gap-1.5 text-[length:var(--text-meta)]" style={{ color: "var(--color-text-secondary)" }}>
                          <span style={{ color: "var(--color-bull)" }}>
                            <Icon name="check" size={12} />
                          </span>
                          {f}
                        </div>
                      ))}
                    </div>
                    <Btn
                      variant={isCurrent ? "soft" : "prim"}
                      disabled={isCurrent || busy !== null}
                      onClick={() => isSubscribed ? changePlan(p) : startCheckout(p)}
                    >
                      {btnLabel}
                    </Btn>
                  </div>
                );
              })}
            </div>

            <div className="mt-3 text-[length:var(--text-meta)]" style={{ color: "var(--color-muted)" }}>
              {isSubscribed && "Plan changes are prorated to your billing cycle."}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: number | string; sub: string }) {
  return (
    <div
      className="rounded-[var(--radius-md)] px-4 py-4"
      style={{ background: "var(--color-bg)", border: "1px solid var(--color-border)" }}
    >
      <div
        className="text-[length:var(--text-micro)] font-bold uppercase"
        style={{ letterSpacing: "0.14em", color: "var(--color-muted)" }}
      >
        {label}
      </div>
      <div
        className="text-[length:var(--text-stat)] font-bold leading-none mt-2 tabular-nums"
        style={{ fontFamily: "var(--font-serif)", color: "var(--color-text)" }}
      >
        {value}
      </div>
      <div className="mono text-[length:var(--text-meta)] mt-[5px]" style={{ color: "var(--color-text-secondary)" }}>
        {sub}
      </div>
    </div>
  );
}

interface UsageMeter {
  used: number;
  limit: number | null;
  pct: number;
}
interface UsageSummary {
  plan: string;
  source?: string;
  trialEndsAt?: string | null;
  daily: UsageMeter;
  weekly: UsageMeter;
  monthly: UsageMeter;
  deepResearch: { used: number; limit: number | null };
  series: { date: string; credits: number }[];
  resets: { daily: string; weekly: string; monthly: string };
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function UsageBar({ pct, used, limit }: { pct: number; used: number; limit: number | null }) {
  const unlimited = limit === null;
  const over = !unlimited && pct >= 100;
  return (
    <div style={{ width: 220 }}>
      <div className="h-[7px] rounded-full overflow-hidden" style={{ background: "var(--color-surface-2)" }}>
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{
            width: unlimited ? "100%" : `${Math.min(100, pct)}%`,
            background: over ? "var(--color-bear)" : "var(--color-accent)",
            opacity: unlimited ? 0.25 : 1,
          }}
        />
      </div>
      <div className="mono flex justify-between text-[length:var(--text-meta)] mt-1.5" style={{ color: "var(--color-text-secondary)" }}>
        <span>
          {unlimited ? `${Math.round(used)} credits` : `${Math.round(used)} / ${limit} credits`}
        </span>
        <span style={{ fontWeight: 700, color: over ? "var(--color-bear)" : "var(--color-text)" }}>
          {unlimited ? "Unlimited" : `${pct}%`}
        </span>
      </div>
    </div>
  );
}

function meterSub(m: UsageMeter | undefined): string {
  if (!m) return "of allowance";
  if (m.limit === null) return `${Math.round(m.used)} credits · unlimited`;
  return `${Math.round(m.used)} / ${m.limit} credits`;
}

function UsageSection({ onUpgrade }: { onUpgrade: () => void }) {
  const { user } = useAuth();
  const { data } = useSWR<UsageSummary>(user ? "/api/usage" : null, authFetcher, {
    revalidateOnFocus: true,
  });

  const weekly = data?.weekly;
  const daily = data?.daily;
  const monthly = data?.monthly;
  const deep = data?.deepResearch;
  const series = data?.series ?? [];
  const hasUsage = series.some((s) => s.credits > 0);

  return (
    <div>
      <Head title="Usage" description="Your AI usage this period and your plan limits." />

      <div className="grid grid-cols-3 gap-3" style={{ margin: "4px 0 22px" }}>
        <StatCard
          label="Plan"
          value={data?.plan ?? "—"}
          sub={data?.source === "trial" ? "trial" : "current"}
        />
        <StatCard
          label="This month"
          value={monthly ? (monthly.limit === null ? "—" : `${monthly.pct}%`) : "—"}
          sub={meterSub(monthly)}
        />
        <StatCard
          label="Deep Research"
          value={deep ? (deep.limit === null ? `${deep.used}` : `${deep.used}/${deep.limit}`) : "—"}
          sub={deep?.limit === null ? "unlimited · fair use" : "runs this period"}
        />
      </div>

      <Row label="Monthly allowance" description="Cost-weighted across every model. Resets on the 1st (UTC).">
        <UsageBar pct={monthly?.pct ?? 0} used={monthly?.used ?? 0} limit={monthly?.limit ?? 0} />
      </Row>

      <Row label="Weekly allowance" description="Rolling 7-day window.">
        <UsageBar pct={weekly?.pct ?? 0} used={weekly?.used ?? 0} limit={weekly?.limit ?? 0} />
      </Row>

      <Row label="Daily allowance" description="Anti-abuse ceiling. Resets at midnight UTC.">
        <UsageBar pct={daily?.pct ?? 0} used={daily?.used ?? 0} limit={daily?.limit ?? 0} />
      </Row>

      <div className="mt-7">
        <p className="text-[length:var(--text-sm)] font-semibold" style={{ color: "var(--color-text)" }}>
          Usage over time
        </p>
        <p className="text-[length:var(--text-sm)] mt-[3px] mb-3" style={{ color: "var(--color-text-secondary)" }}>
          Credits used per day over the last 30 days.
        </p>
        <div style={{ height: 196 }}>
          {hasUsage ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ top: 6, right: 8, bottom: 0, left: -16 }}>
                <defs>
                  <linearGradient id="settingsUsageArea" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridProps} />
                <XAxis dataKey="date" tickFormatter={fmtDay} {...axisProps} minTickGap={32} />
                <YAxis {...axisProps} width={32} allowDecimals={false} />
                <Tooltip
                  content={({ active, label, payload }) => (
                    <ChartTooltip
                      active={active}
                      label={label != null && label !== "" ? fmtDay(String(label)) : undefined}
                      payload={payload as unknown as React.ComponentProps<typeof ChartTooltip>["payload"]}
                      formatValue={(v) => `${Math.round(Number(v))}`}
                    />
                  )}
                  cursor={{ stroke: "var(--color-border-strong)", strokeWidth: 1 }}
                />
                <Area type="monotone" dataKey="credits" stroke="var(--color-accent)" strokeWidth={1.8} fill="url(#settingsUsageArea)" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div
              className="h-full flex items-center justify-center rounded-[var(--radius-md)] text-center px-6"
              style={{ border: "1px dashed var(--color-border)", color: "var(--color-muted)", fontSize: "var(--text-sm)" }}
            >
              No usage yet — your AI activity will chart here as you use Finava.
            </div>
          )}
        </div>
      </div>

      <div className="mt-7">
        <Row label="Need more headroom?" description="Upgrade for a larger monthly allowance and more Deep Research.">
          <Btn variant="prim" onClick={onUpgrade}>Upgrade plan</Btn>
        </Row>
      </div>
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const router = useRouter();
  const [active, setActive] = useState<SectionId>("general");
  const [checkoutNotice, setCheckoutNotice] = useState<"success" | "cancel" | null>(null);
  const { data: userData, mutate } = useSWR<UserData>("/api/user", authFetcher);
  const contentRef = useRef<HTMLDivElement>(null);

  // Deep links like /settings?section=usage (from the sidebar usage popover and
  // the user menu) open the matching section on load.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const sec = params.get("section");
    if (sec && NAV.some((g) => g.items.some((it) => it.id === sec))) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActive(sec as SectionId);
    }

    // Returning from Stripe Checkout. The webhook grants the plan, and may land
    // a beat after the browser redirect — so poll-revalidate /api/user briefly.
    const checkout = params.get("checkout");
    if (checkout === "success" || checkout === "cancel") {
      setCheckoutNotice(checkout);
      if (checkout === "success") {
        let n = 0;
        const t = setInterval(() => {
          mutate();
          if (++n >= 5) clearInterval(t);
        }, 1500);
      }
      // Strip the query so a refresh doesn't re-trigger the notice.
      window.history.replaceState({}, "", "/settings?section=billing");
    }
  }, [mutate]);

  function exitSettings() {
    router.push("/chat");
  }

  function nav(id: SectionId) {
    setActive(id);
    contentRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }

  return (
    <div className="flex h-full" style={{ background: "var(--color-bg)" }}>
      {/* Left rail */}
      <nav
        className="flex-shrink-0 flex flex-col"
        style={{
          width: 232,
          padding: "26px 14px 14px",
          borderRight: "1px solid var(--color-border)",
          background: "var(--color-sidebar)",
        }}
      >
        <button
          onClick={exitSettings}
          className="settings-back inline-flex items-center gap-1.5 text-[length:var(--text-sm)] font-medium rounded-[var(--radius-sm)] transition-colors duration-100"
          style={{ color: "var(--color-text-secondary)", padding: "5px 8px", margin: "0 2px 10px", alignSelf: "flex-start" }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" y1="12" x2="5" y2="12" />
            <polyline points="12 19 5 12 12 5" />
          </svg>
          Back to app
        </button>
        <div
          className="text-[length:var(--text-display)] font-bold tracking-[-0.01em]"
          style={{ fontFamily: "var(--font-serif)", color: "var(--color-text)", padding: "0 10px", marginBottom: 22 }}
        >
          Settings
        </div>
        {NAV.map((g) => (
          <div key={g.grp} className="mb-[18px]">
            <div className="eyebrow-label" style={{ padding: "0 10px 7px", letterSpacing: "0.18em", color: "var(--color-muted)" }}>
              {g.grp}
            </div>
            {g.items.map((it) => (
              <button
                key={it.id}
                onClick={() => nav(it.id)}
                className={`settings-nav-item${active === it.id ? " is-active" : ""} w-full flex items-center gap-2.5 px-2.5 py-2 rounded-[var(--radius-md)] text-[length:var(--text-sm)] font-medium text-left mb-[1px] transition-colors duration-100`}
              >
                <span className="flex-shrink-0" style={{ opacity: active === it.id ? 1 : 0.85 }}>
                  <Icon name={it.icon} size={16} />
                </span>
                {it.label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      {/* Content */}
      <div ref={contentRef} className="flex-1 overflow-y-auto">
        <div style={{ maxWidth: active === "templates" ? 1000 : 624, margin: "0 auto", padding: "40px 44px 64px" }}>
          {checkoutNotice && (
            <div
              className="mb-5 rounded-[var(--radius-md)] px-4 py-3 text-[length:var(--text-sm)] flex items-center justify-between"
              style={{
                border: `1px solid ${checkoutNotice === "success" ? "var(--color-bull)" : "var(--color-border-strong)"}`,
                background: "var(--color-surface)",
                color: "var(--color-text)",
              }}
            >
              <span>
                {checkoutNotice === "success"
                  ? "Payment received — finalizing your subscription…"
                  : "Checkout canceled. No charge was made."}
              </span>
              <button
                onClick={() => setCheckoutNotice(null)}
                className="text-[length:var(--text-sm)] font-semibold"
                style={{ color: "var(--color-text-secondary)" }}
              >
                Dismiss
              </button>
            </div>
          )}
          {active === "general" && <GeneralSection />}
          {active === "templates" && <TemplatesSection />}
          {active === "appearance" && <AppearanceSection />}
          {active === "notifications" && <NotificationsSection userData={userData} mutate={mutate} />}
          {active === "connections" && <ConnectionsSection userData={userData} />}
          {active === "account" && <ProfileSection userData={userData} mutate={mutate} />}
          {active === "privacy" && <PrivacySection userData={userData} mutate={mutate} />}
          {active === "billing" && <BillingSection userData={userData} mutate={mutate} />}
          {active === "usage" && <UsageSection onUpgrade={() => nav("billing")} />}
        </div>
      </div>
    </div>
  );
}
