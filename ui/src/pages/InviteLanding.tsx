import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AGENT_ADAPTER_TYPES } from "@workcell/shared";
import type { AgentAdapterType, JoinRequest } from "@workcell/shared";
import { Button } from "@/components/ui/button";
import { CompanyPatternIcon } from "@/components/CompanyPatternIcon";
import { useCompany } from "@/context/CompanyContext";
import { Link, useNavigate, useParams } from "@/lib/router";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { companiesListQueryOptions } from "../api/companies-query";
import { healthApi } from "../api/health";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { clearPendingInviteToken, rememberPendingInviteToken } from "../lib/invite-memory";
import { queryKeys } from "../lib/queryKeys";
import { formatDate } from "../lib/utils";
import { useTranslation } from "@/i18n";

type AuthMode = "sign_in" | "sign_up";
type AuthFeedback = { tone: "error" | "info"; message: string };

const joinAdapterOptions: AgentAdapterType[] = [...AGENT_ADAPTER_TYPES];
const ENABLED_INVITE_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "cursor",
]);

function readNestedString(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" && current.trim().length > 0 ? current : null;
}

const fieldClassName =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]";
const panelClassName = "rounded-lg border border-border bg-card p-6";
const modeButtonBaseClassName =
  "flex-1 rounded-md border px-3 py-2 text-sm transition-colors";

function formatHumanRole(role: string | null | undefined) {
  if (!role) return null;
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function getAuthErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.trim().length > 0 ? code : null;
}

function getAuthErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return null;
  const message = error.message.trim();
  return message.length > 0 ? message : null;
}

function mapInviteAuthFeedback(
  error: unknown,
  authMode: AuthMode,
  email: string,
): AuthFeedback {
  const code = getAuthErrorCode(error);
  const message = getAuthErrorMessage(error);
  const emailLabel = email.trim().length > 0 ? email.trim() : "that email";

  if (code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
    return {
      tone: "info",
      message: `An account already exists for ${emailLabel}. Sign in below to continue with this invite.`,
    };
  }

  if (code === "INVALID_EMAIL_OR_PASSWORD") {
    return {
      tone: "error",
      message:
        "That email and password did not match an existing Workcell account. Check both fields, or create an account first if you are new here.",
    };
  }

  if (authMode === "sign_in" && message === "Request failed: 401") {
    return {
      tone: "error",
      message:
        "That email and password did not match an existing Workcell account. Check both fields, or create an account first if you are new here.",
    };
  }

  if (authMode === "sign_up" && message === "Request failed: 422") {
    return {
      tone: "info",
      message: `An account may already exist for ${emailLabel}. Try signing in instead.`,
    };
  }

  return {
    tone: "error",
    message: message ?? "Authentication failed",
  };
}

function isBootstrapAcceptancePayload(payload: unknown) {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "bootstrapAccepted" in (payload as Record<string, unknown>),
  );
}

function isApprovedHumanJoinPayload(payload: unknown, showsAgentForm: boolean) {
  if (!payload || typeof payload !== "object" || showsAgentForm) return false;
  const status = (payload as { status?: unknown }).status;
  return status === "approved";
}

type AwaitingJoinApprovalPanelProps = {
  companyDisplayName: string;
  companyLogoUrl: string | null;
  companyBrandColor: string | null;
  invitedByUserName: string | null;
  claimSecret?: string | null;
  claimApiKeyPath?: string | null;
  onboardingTextUrl?: string | null;
};

function InviteCompanyLogo({
  companyDisplayName,
  companyLogoUrl,
  companyBrandColor,
  className,
}: {
  companyDisplayName: string;
  companyLogoUrl: string | null;
  companyBrandColor: string | null;
  className?: string;
}) {
  return (
    <CompanyPatternIcon
      companyName={companyDisplayName}
      logoUrl={companyLogoUrl}
      brandColor={companyBrandColor}
      logoFit="contain"
      className={className}
    />
  );
}

function AwaitingJoinApprovalPanel({
  companyDisplayName,
  companyLogoUrl,
  companyBrandColor,
  invitedByUserName,
  claimSecret = null,
  claimApiKeyPath = null,
  onboardingTextUrl = null,
}: AwaitingJoinApprovalPanelProps) {
  const { t } = useTranslation();
  const approvalUrl = `${window.location.origin}/company/settings/members`;
  const approverLabel = invitedByUserName ?? t("inviteLanding.awaiting.defaultApprover", { defaultValue: "A team admin" });

  return (
    <div className="min-h-screen bg-background px-6 py-12 text-foreground">
      <div className="mx-auto max-w-md rounded-lg border border-border bg-card p-6" data-testid="invite-pending-approval">
        <div className="flex items-center gap-3">
          <InviteCompanyLogo
            companyDisplayName={companyDisplayName}
            companyLogoUrl={companyLogoUrl}
            companyBrandColor={companyBrandColor}
            className="h-12 w-12 rounded-md border border-border"
          />
          <h1 className="text-lg font-semibold">{t("inviteLanding.awaiting.title", { defaultValue: "Request to join {{company}}", company: companyDisplayName })}</h1>
        </div>
        <div className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            {t("inviteLanding.awaiting.pendingApproval", {
              defaultValue: "Your request is still awaiting approval. {{approver}} must approve your request to join.",
              approver: approverLabel,
            })}
          </p>
          <div className="rounded-md border border-border p-3">
            <p className="text-xs text-muted-foreground mb-1">{t("inviteLanding.awaiting.approvalPage", { defaultValue: "Approval page" })}</p>
            <a
              href={approvalUrl}
              className="text-sm text-foreground underline underline-offset-2 hover:text-foreground/80"
            >
              {t("inviteLanding.awaiting.membersLink", { defaultValue: "Team Settings → Members" })}
            </a>
          </div>
          <p className="text-sm text-muted-foreground">
            {t("inviteLanding.awaiting.askToVisitPrefix", { defaultValue: "Ask them to visit" })} <a href={approvalUrl} className="text-foreground underline underline-offset-2 hover:text-foreground/80">{t("inviteLanding.awaiting.membersLink", { defaultValue: "Team Settings → Members" })}</a> {t("inviteLanding.awaiting.askToVisitSuffix", { defaultValue: "to approve your request." })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("inviteLanding.awaiting.refreshHint", {
              defaultValue: "Refresh this page after you've been approved — you'll be redirected automatically.",
            })}
          </p>
        </div>
        {claimSecret && claimApiKeyPath ? (
          <div className="mt-4 space-y-1 rounded-md border border-border p-3 text-xs text-muted-foreground">
            <div className="text-foreground">{t("inviteLanding.awaiting.claimSecret", { defaultValue: "Claim secret" })}</div>
            <div className="font-mono break-all">{claimSecret}</div>
            <div className="font-mono break-all">POST {claimApiKeyPath}</div>
          </div>
        ) : null}
        {onboardingTextUrl ? (
          <div className="mt-4 text-xs text-muted-foreground">
            {t("inviteLanding.awaiting.onboardingLabel", { defaultValue: "Onboarding:" })} <span className="font-mono break-all">{onboardingTextUrl}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function InviteLandingPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { setSelectedCompanyId } = useCompany();
  const params = useParams();
  const token = (params.token ?? "").trim();
  const [authMode, setAuthMode] = useState<AuthMode>("sign_up");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agentName, setAgentName] = useState("");
  const [adapterType, setAdapterType] = useState<AgentAdapterType>("claude_local");
  const [capabilities, setCapabilities] = useState("");
  const [result, setResult] = useState<{ kind: "bootstrap" | "join"; payload: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [authFeedback, setAuthFeedback] = useState<AuthFeedback | null>(null);
  const [autoAcceptStarted, setAutoAcceptStarted] = useState(false);

  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });
  const sessionQuery = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });
  const inviteQuery = useQuery({
    queryKey: queryKeys.access.invite(token),
    queryFn: () => accessApi.getInvite(token),
    enabled: token.length > 0,
    retry: false,
  });

  const companiesQuery = useQuery({
    ...companiesListQueryOptions,
    enabled: !!sessionQuery.data && !!inviteQuery.data?.companyId,
  });
  const companyList = companiesQuery.data?.companies ?? [];

  useEffect(() => {
    if (token) rememberPendingInviteToken(token);
  }, [token]);

  useEffect(() => {
    setAutoAcceptStarted(false);
  }, [token]);

  useEffect(() => {
    const list = companiesQuery.data?.companies;
    if (!list || !inviteQuery.data?.companyId) return;
    if (list.some((c) => c.id === inviteQuery.data!.companyId)) {
      clearPendingInviteToken(token);
    }
  }, [companiesQuery.data, inviteQuery.data, token]);

  const invite = inviteQuery.data;
  const isCheckingExistingMembership =
    Boolean(sessionQuery.data) &&
    Boolean(invite?.companyId) &&
    companiesQuery.isLoading;
  const isCurrentMember =
    Boolean(invite?.companyId) &&
    companyList.some((company) => company.id === invite?.companyId);
  const companyName = invite?.companyName?.trim() || null;
  const companyDisplayName = companyName || t("inviteLanding.companyFallback", { defaultValue: "this Workcell team" });
  const companyLogoUrl = invite?.companyLogoUrl?.trim() || null;
  const companyBrandColor = invite?.companyBrandColor?.trim() || null;
  const invitedByUserName = invite?.invitedByUserName?.trim() || null;
  const inviteMessage = invite?.inviteMessage?.trim() || null;
  const requestedHumanRole = formatHumanRole(invite?.humanRole);
  const inviteJoinRequestStatus = invite?.joinRequestStatus ?? null;
  const inviteJoinRequestType = invite?.joinRequestType ?? null;
  const canCompleteAcceptedHumanInvite =
    inviteJoinRequestType === "human" &&
    (inviteJoinRequestStatus === "pending_approval" || inviteJoinRequestStatus === "approved");
  const requiresHumanAccount =
    healthQuery.data?.deploymentMode === "authenticated" &&
    !sessionQuery.data &&
    invite?.allowedJoinTypes !== "agent";
  const showsAgentForm = invite?.inviteType !== "bootstrap_ceo" && invite?.allowedJoinTypes === "agent";
  const shouldAutoAcceptHumanInvite =
    Boolean(sessionQuery.data) &&
    !showsAgentForm &&
    invite?.inviteType !== "bootstrap_ceo" &&
    (!inviteJoinRequestStatus || canCompleteAcceptedHumanInvite) &&
    !isCheckingExistingMembership &&
    !isCurrentMember &&
    !result &&
    error === null;
  const sessionLabel =
    sessionQuery.data?.user.name?.trim() ||
    sessionQuery.data?.user.email?.trim() ||
    t("inviteLanding.sessionFallback", { defaultValue: "this account" });

  const authCanSubmit =
    email.trim().length > 0 &&
    password.trim().length > 0 &&
    (authMode === "sign_in" || (name.trim().length > 0 && password.trim().length >= 8));

  const acceptMutation = useMutation({
    mutationFn: async () => {
      if (!invite) throw new Error("Invite not found");
      if (isCheckingExistingMembership) {
        throw new Error("Checking your company access. Try again in a moment.");
      }
      if (isCurrentMember) {
        throw new Error("This account already belongs to the company.");
      }
      if (invite.inviteType === "bootstrap_ceo" || invite.allowedJoinTypes !== "agent") {
        return accessApi.acceptInvite(token, { requestType: "human" });
      }
      return accessApi.acceptInvite(token, {
        requestType: "agent",
        agentName: agentName.trim(),
        adapterType,
        capabilities: capabilities.trim() || null,
      });
    },
    onSuccess: async (payload) => {
      setError(null);
      clearPendingInviteToken(token);
      const asBootstrap = isBootstrapAcceptancePayload(payload);
      setResult({ kind: asBootstrap ? "bootstrap" : "join", payload });
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
      await queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
      if (invite?.companyId && isApprovedHumanJoinPayload(payload, showsAgentForm)) {
        setSelectedCompanyId(invite.companyId, { source: "manual" });
        navigate("/", { replace: true });
      }
    },
    onError: (err) => {
      setError(
        err instanceof Error
          ? err.message
          : t("inviteLanding.error.acceptFailed", { defaultValue: "Failed to accept invite" }),
      );
    },
  });

  useEffect(() => {
    if (!shouldAutoAcceptHumanInvite || autoAcceptStarted || acceptMutation.isPending) return;
    setAutoAcceptStarted(true);
    setError(null);
    acceptMutation.mutate();
  }, [acceptMutation, autoAcceptStarted, shouldAutoAcceptHumanInvite]);

  const authMutation = useMutation({
    mutationFn: async () => {
      if (authMode === "sign_in") {
        await authApi.signInEmail({ email: email.trim(), password });
        return;
      }
      await authApi.signUpEmail({
        name: name.trim(),
        email: email.trim(),
        password,
      });
    },
    onSuccess: async () => {
      setAuthFeedback(null);
      rememberPendingInviteToken(token);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.access.currentBoardAccess });
      const { companies: freshCompanies } = await queryClient.fetchQuery(companiesListQueryOptions);

      if (invite?.companyId && freshCompanies.some((company) => company.id === invite.companyId)) {
        clearPendingInviteToken(token);
        setSelectedCompanyId(invite.companyId, { source: "manual" });
        navigate("/", { replace: true });
        return;
      }

      if (!invite || invite.inviteType !== "bootstrap_ceo") {
        return;
      }

      try {
        const payload = await acceptMutation.mutateAsync();
        if (isBootstrapAcceptancePayload(payload)) {
          navigate("/", { replace: true });
        }
      } catch {
        return;
      }
    },
    onError: (err) => {
      const nextFeedback = mapInviteAuthFeedback(err, authMode, email);
      if (getAuthErrorCode(err) === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
        setAuthMode("sign_in");
        setPassword("");
      }
      setAuthFeedback(nextFeedback);
    },
  });

  const joinButtonLabel = useMemo(() => {
    if (!invite) return t("inviteLanding.joinButton.continue", { defaultValue: "Continue" });
    if (isCurrentMember) return t("inviteLanding.joinButton.openCompany", { defaultValue: "Open team" });
    if (invite.inviteType === "bootstrap_ceo") return t("inviteLanding.joinButton.acceptInvite", { defaultValue: "Accept invite" });
    if (showsAgentForm) return t("inviteLanding.joinButton.submitRequest", { defaultValue: "Submit request" });
    return sessionQuery.data
      ? t("inviteLanding.joinButton.acceptInvite", { defaultValue: "Accept invite" })
      : t("inviteLanding.joinButton.continue", { defaultValue: "Continue" });
  }, [invite, isCurrentMember, sessionQuery.data, showsAgentForm, t]);

  if (!token) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-destructive">{t("inviteLanding.invalidToken", { defaultValue: "Invalid invite token." })}</div>;
  }

  if (inviteQuery.isLoading || healthQuery.isLoading || sessionQuery.isLoading) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("inviteLanding.loadingInvite", { defaultValue: "Loading invite..." })}</div>;
  }

  if (isCheckingExistingMembership) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("inviteLanding.checkingAccess", { defaultValue: "Checking your access..." })}</div>;
  }

  if (inviteQuery.error || !invite) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="border border-border bg-card p-6" data-testid="invite-error">
          <h1 className="text-lg font-semibold">{t("inviteLanding.notAvailable.title", { defaultValue: "Invite not available" })}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {t("inviteLanding.notAvailable.expiredRevokedUsed", {
              defaultValue: "This invite may be expired, revoked, or already used.",
            })}
          </p>
        </div>
      </div>
    );
  }

  if (
    inviteJoinRequestStatus === "approved" &&
    inviteJoinRequestType === "human" &&
    isCurrentMember
  ) {
    return <div className="mx-auto max-w-xl py-10 text-sm text-muted-foreground">{t("inviteLanding.openingCompany", { defaultValue: "Opening team..." })}</div>;
  }

  if (inviteJoinRequestStatus === "pending_approval" && !canCompleteAcceptedHumanInvite) {
    return (
      <AwaitingJoinApprovalPanel
        companyDisplayName={companyDisplayName}
        companyLogoUrl={companyLogoUrl}
        companyBrandColor={companyBrandColor}
        invitedByUserName={invitedByUserName}
      />
    );
  }

  if (inviteJoinRequestStatus && !canCompleteAcceptedHumanInvite) {
    return (
      <div className="mx-auto max-w-xl py-10">
        <div className="border border-border bg-card p-6" data-testid="invite-error">
          <h1 className="text-lg font-semibold">{t("inviteLanding.notAvailable.title", { defaultValue: "Invite not available" })}</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {inviteJoinRequestStatus === "rejected"
              ? t("inviteLanding.notAvailable.rejected", { defaultValue: "This join request was not approved." })
              : t("inviteLanding.notAvailable.alreadyUsed", { defaultValue: "This invite has already been used." })}
          </p>
        </div>
      </div>
    );
  }

  if (result?.kind === "bootstrap") {
    return (
      <div className="min-h-screen bg-background px-6 py-12 text-foreground">
        <div className="mx-auto max-w-md rounded-lg border border-border bg-card p-6">
          <h1 className="text-lg font-semibold">{t("inviteLanding.bootstrapComplete.title", { defaultValue: "Bootstrap complete" })}</h1>
          <div className="mt-4">
            <Button asChild>
              <Link to="/">{t("inviteLanding.openBoard", { defaultValue: "Open board" })}</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (result?.kind === "join") {
    const payload = result.payload as JoinRequest & {
      claimSecret?: string;
      claimApiKeyPath?: string;
      onboarding?: Record<string, unknown>;
    };
    const claimSecret = typeof payload.claimSecret === "string" ? payload.claimSecret : null;
    const claimApiKeyPath = typeof payload.claimApiKeyPath === "string" ? payload.claimApiKeyPath : null;
    const onboardingTextUrl = readNestedString(payload.onboarding, ["textInstructions", "url"]);
    const joinedNow = !showsAgentForm && payload.status === "approved";

    return (
      joinedNow ? (
        <div className="min-h-screen bg-background px-6 py-12 text-foreground">
          <div className="mx-auto max-w-md rounded-lg border border-border bg-card p-6">
            <div className="flex items-center gap-3">
              <InviteCompanyLogo
                companyDisplayName={companyDisplayName}
                companyLogoUrl={companyLogoUrl}
                companyBrandColor={companyBrandColor}
                className="h-12 w-12 rounded-md border border-border"
              />
              <h1 className="text-lg font-semibold">{t("inviteLanding.joinedCompany.title", { defaultValue: "You joined the team" })}</h1>
            </div>
            <div className="mt-4">
              <Button asChild className="w-full">
                <Link to="/">{t("inviteLanding.openBoard", { defaultValue: "Open board" })}</Link>
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <AwaitingJoinApprovalPanel
          companyDisplayName={companyDisplayName}
          companyLogoUrl={companyLogoUrl}
          companyBrandColor={companyBrandColor}
          invitedByUserName={invitedByUserName}
          claimSecret={claimSecret}
          claimApiKeyPath={claimApiKeyPath}
          onboardingTextUrl={onboardingTextUrl}
        />
      )
    );
  }

  return (
    <div className="min-h-screen bg-background px-6 py-12 text-foreground">
      <div className="mx-auto max-w-5xl">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
          <section className={`${panelClassName} space-y-6`}>
            <div className="flex items-start gap-4">
              <InviteCompanyLogo
                companyDisplayName={companyDisplayName}
                companyLogoUrl={companyLogoUrl}
                companyBrandColor={companyBrandColor}
                className="h-16 w-16 rounded-md border border-border"
              />
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-[0.24em] text-muted-foreground">
                  {t("inviteLanding.eyebrow", { defaultValue: "You've been invited to join Workcell" })}
                </p>
                <h1 className="mt-2 text-2xl font-semibold">
                  {invite.inviteType === "bootstrap_ceo"
                    ? t("inviteLanding.heading.setUp", { defaultValue: "Set up Workcell" })
                    : t("inviteLanding.heading.join", { defaultValue: "Join {{company}}", company: companyDisplayName })}
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                  {showsAgentForm
                    ? t("inviteLanding.intro.agent", {
                        defaultValue: "Review the invite details, then submit the agent information below to start the join request.",
                      })
                    : requiresHumanAccount
                      ? t("inviteLanding.intro.createAccount", {
                          defaultValue: "Create your Workcell account first. If you already have one, switch to sign in and continue the invite with the same email.",
                        })
                      : t("inviteLanding.intro.ready", {
                          defaultValue: "Your account is ready. Review the invite details, then accept it to continue.",
                        })}
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-md border border-border p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{t("inviteLanding.details.company", { defaultValue: "Team" })}</div>
                <div className="mt-1 text-sm text-foreground">{companyDisplayName}</div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{t("inviteLanding.details.invitedBy", { defaultValue: "Invited by" })}</div>
                <div className="mt-1 text-sm text-foreground">{invitedByUserName ?? t("inviteLanding.details.invitedByFallback", { defaultValue: "Workcell board" })}</div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{t("inviteLanding.details.requestedAccess", { defaultValue: "Requested access" })}</div>
                <div className="mt-1 text-sm text-foreground">
                  {showsAgentForm
                    ? t("inviteLanding.details.agentJoinRequest", { defaultValue: "Agent join request" })
                    : requestedHumanRole ?? t("inviteLanding.details.companyAccess", { defaultValue: "Team access" })}
                </div>
              </div>
              <div className="rounded-md border border-border p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{t("inviteLanding.details.inviteExpires", { defaultValue: "Invite expires" })}</div>
                <div className="mt-1 text-sm text-foreground">{formatDate(invite.expiresAt)}</div>
              </div>
            </div>

            {inviteMessage ? (
              <div className="border border-amber-500/40 bg-amber-500/10 p-4">
                <div className="text-xs uppercase tracking-[0.2em] text-amber-200/80">{t("inviteLanding.messageFromInviter", { defaultValue: "Message from inviter" })}</div>
                <p className="mt-2 text-sm leading-6 text-amber-50">{inviteMessage}</p>
              </div>
            ) : null}

            {sessionQuery.data ? (
              <div className="border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-50">
                {t("inviteLanding.signedInAsPrefix", { defaultValue: "Signed in as" })} <span className="font-medium">{sessionLabel}</span>{t("inviteLanding.signedInAsSuffix", { defaultValue: "." })}
              </div>
            ) : null}
          </section>

          <section className={`${panelClassName} h-fit`}>
            {showsAgentForm ? (
              <div className="space-y-4">
                <div>
                  <h2 className="text-lg font-semibold">{t("inviteLanding.agentForm.title", { defaultValue: "Submit agent details" })}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("inviteLanding.agentForm.description", {
                      defaultValue: "This invite will create an approval request for a new agent in {{company}}.",
                      company: companyDisplayName,
                    })}
                  </p>
                </div>
                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">{t("inviteLanding.agentForm.agentName", { defaultValue: "Agent name" })}</span>
                  <input
                    className={fieldClassName}
                    value={agentName}
                    onChange={(event) => setAgentName(event.target.value)}
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">{t("inviteLanding.agentForm.adapterType", { defaultValue: "Adapter type" })}</span>
                  <select
                    className={fieldClassName}
                    value={adapterType}
                    onChange={(event) => setAdapterType(event.target.value as AgentAdapterType)}
                  >
                    {joinAdapterOptions.map((type) => (
                      <option key={type} value={type} disabled={!ENABLED_INVITE_ADAPTERS.has(type)}>
                        {getAdapterLabel(type)}{!ENABLED_INVITE_ADAPTERS.has(type) ? t("inviteLanding.agentForm.comingSoon", { defaultValue: " (Coming soon)" }) : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">{t("inviteLanding.agentForm.capabilities", { defaultValue: "Capabilities" })}</span>
                  <textarea
                    className={fieldClassName}
                    rows={4}
                    value={capabilities}
                    onChange={(event) => setCapabilities(event.target.value)}
                  />
                </label>
                {error ? <p className="text-xs text-red-400">{error}</p> : null}
                <Button
                  className="w-full"
                  disabled={acceptMutation.isPending || agentName.trim().length === 0}
                  onClick={() => acceptMutation.mutate()}
                >
                  {acceptMutation.isPending ? t("inviteLanding.working", { defaultValue: "Working..." }) : joinButtonLabel}
                </Button>
              </div>
            ) : requiresHumanAccount ? (
              <div className="space-y-5">
                <div>
                  <h2 className="text-lg font-semibold">
                    {authMode === "sign_up"
                      ? t("inviteLanding.auth.createTitle", { defaultValue: "Create your account" })
                      : t("inviteLanding.auth.signInTitle", { defaultValue: "Sign in to continue" })}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {authMode === "sign_up"
                      ? t("inviteLanding.auth.createDescription", {
                          defaultValue: "Start with a Workcell account. After that, you'll come right back here to accept the invite for {{company}}.",
                          company: companyDisplayName,
                        })
                      : t("inviteLanding.auth.signInDescription", {
                          defaultValue: "Use the Workcell account that already matches this invite. If you do not have one yet, switch back to create account.",
                        })}
                  </p>
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    className={`${modeButtonBaseClassName} ${
                      authMode === "sign_up"
                        ? "border-foreground bg-foreground text-background"
                        : "border-border text-muted-foreground hover:border-muted-foreground"
                    }`}
                    onClick={() => {
                      setAuthFeedback(null);
                      setAuthMode("sign_up");
                    }}
                  >
                    {t("inviteLanding.auth.modeCreate", { defaultValue: "Create account" })}
                  </button>
                  <button
                    type="button"
                    className={`${modeButtonBaseClassName} ${
                      authMode === "sign_in"
                        ? "border-foreground bg-foreground text-background"
                        : "border-border text-muted-foreground hover:border-muted-foreground"
                    }`}
                    onClick={() => {
                      setAuthFeedback(null);
                      setAuthMode("sign_in");
                    }}
                  >
                    {t("inviteLanding.auth.modeExisting", { defaultValue: "I already have an account" })}
                  </button>
                </div>

                <form
                  className="space-y-4"
                  method="post"
                  action={authMode === "sign_up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email"}
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (authMutation.isPending) return;
                    if (!authCanSubmit) {
                      setAuthFeedback({
                        tone: "error",
                        message: t("inviteLanding.auth.requiredFields", {
                          defaultValue: "Please fill in all required fields.",
                        }),
                      });
                      return;
                    }
                    authMutation.mutate();
                  }}
                  data-testid="invite-inline-auth"
                >
                  {authMode === "sign_up" ? (
                    <label className="block text-sm">
                      <span className="mb-1 block text-muted-foreground">{t("inviteLanding.auth.name", { defaultValue: "Name" })}</span>
                      <input
                        name="name"
                        className={fieldClassName}
                        value={name}
                        onChange={(event) => {
                          setName(event.target.value);
                          setAuthFeedback(null);
                        }}
                        autoComplete="name"
                        autoFocus
                      />
                    </label>
                  ) : null}
                  <label className="block text-sm">
                    <span className="mb-1 block text-muted-foreground">{t("inviteLanding.auth.email", { defaultValue: "Email" })}</span>
                    <input
                      name="email"
                      type="email"
                      className={fieldClassName}
                      value={email}
                      onChange={(event) => {
                        setEmail(event.target.value);
                        setAuthFeedback(null);
                      }}
                      autoComplete="email"
                      autoFocus={authMode === "sign_in"}
                    />
                  </label>
                  <label className="block text-sm">
                    <span className="mb-1 block text-muted-foreground">{t("inviteLanding.auth.password", { defaultValue: "Password" })}</span>
                    <input
                      name="password"
                      type="password"
                      className={fieldClassName}
                      value={password}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setAuthFeedback(null);
                      }}
                      autoComplete={authMode === "sign_in" ? "current-password" : "new-password"}
                    />
                  </label>
                  {authFeedback ? (
                    <p
                      className={`text-xs ${
                        authFeedback.tone === "info" ? "text-amber-300" : "text-red-400"
                      }`}
                    >
                      {authFeedback.message}
                    </p>
                  ) : null}
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={authMutation.isPending}
                    aria-disabled={!authCanSubmit || authMutation.isPending}
                  >
                    {authMutation.isPending
                      ? t("inviteLanding.working", { defaultValue: "Working..." })
                      : authMode === "sign_in"
                        ? t("inviteLanding.auth.signInContinue", { defaultValue: "Sign in and continue" })
                        : t("inviteLanding.auth.createContinue", { defaultValue: "Create account and continue" })}
                  </Button>
                </form>

                <p className="text-xs leading-5 text-muted-foreground">
                  {authMode === "sign_up"
                    ? t("inviteLanding.auth.helperSignUp", {
                        defaultValue: "Already signed up before? Use the existing-account option instead so the invite lands on the right Workcell user.",
                      })
                    : t("inviteLanding.auth.helperSignIn", {
                        defaultValue: "No account yet? Switch back to create account so you can accept the invite with a new login.",
                      })}
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <h2 className="text-lg font-semibold">
                    {isCurrentMember
                      ? t("inviteLanding.accept.alreadyMemberTitle", { defaultValue: "Already in this team" })
                      : shouldAutoAcceptHumanInvite
                      ? t("inviteLanding.accept.completingTitle", { defaultValue: "Completing team access" })
                      : invite.inviteType === "bootstrap_ceo"
                        ? t("inviteLanding.accept.bootstrapTitle", { defaultValue: "Accept bootstrap invite" })
                        : t("inviteLanding.accept.companyTitle", { defaultValue: "Accept team invite" })}
                  </h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {shouldAutoAcceptHumanInvite
                      ? t("inviteLanding.accept.grantingAccess", {
                          defaultValue: "Granting your access to {{company}}.",
                          company: companyDisplayName,
                        })
                      : isCurrentMember
                      ? t("inviteLanding.accept.alreadyBelongs", {
                          defaultValue: "This account already belongs to {{company}}.",
                          company: companyDisplayName,
                        })
                      : invite.inviteType === "bootstrap_ceo"
                      ? t("inviteLanding.accept.willFinishSetup", {
                          defaultValue: "This will finish setting up Workcell.",
                        })
                      : t("inviteLanding.accept.willGrantAccess", {
                          defaultValue: "This will grant or complete your access to {{company}}.",
                          company: companyDisplayName,
                        })}
                  </p>
                </div>
                {error ? <p className="text-xs text-red-400">{error}</p> : null}
                {shouldAutoAcceptHumanInvite ? (
                  <div className="text-sm text-muted-foreground">
                    {acceptMutation.isPending
                      ? t("inviteLanding.accept.submittingRequest", { defaultValue: "Submitting request..." })
                      : t("inviteLanding.accept.finishingSignIn", { defaultValue: "Finishing sign-in..." })}
                  </div>
                ) : (
                  <Button
                    className="w-full"
                    disabled={acceptMutation.isPending}
                    onClick={() => {
                      if (isCurrentMember && invite.companyId) {
                        clearPendingInviteToken(token);
                        setSelectedCompanyId(invite.companyId, { source: "manual" });
                        navigate("/", { replace: true });
                        return;
                      }
                      acceptMutation.mutate();
                    }}
                  >
                    {acceptMutation.isPending ? t("inviteLanding.working", { defaultValue: "Working..." }) : joinButtonLabel}
                  </Button>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
