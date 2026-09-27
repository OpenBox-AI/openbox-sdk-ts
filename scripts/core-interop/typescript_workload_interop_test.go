package api

// TypeScript ↔ Core IAM v3 interoperability gate.
//
// This file is NOT part of openbox-core. openbox-sdk-ts's
// scripts/core-interop/run-core-workload-interop.mjs injects it into Core's internal/api
// package with `go test -overlay`, so the TypeScript SDK is exercised against
// Core's REAL v3 router, workload-token verifier, and candidate-proof verifier
// without modifying the Core checkout.
//
// What is real: Core's router and handlers for bootstrap, validate, and the
// candidate transition routes; Core's authenticateRuntimeAgent (the exact v3
// authentication every runtime route calls) for evaluate/approval/handoffs;
// Core's KeycloakWorkloadTokenVerifier and KeycloakWorkloadTransitionProofVerifier.
// What is controlled: the authority datastores (in-memory, mutable to simulate
// activation changes), the business response after authentication, and a
// Keycloak token endpoint that verifies the SDK's RFC 7523 client assertion and
// mints realm-signed access tokens with Keycloak's claim layout. The SDK never
// mints access tokens; this test issuer does.

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"openbox-core/internal/content"
	"openbox-core/internal/services"
	"openbox-core/internal/services/identity"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/samber/do/v2"
)

const (
	tsInteropAudience     = "openbox-core"
	tsInteropRealmKid     = "interop-realm-key-1"
	tsInteropNextRealmKid = "interop-realm-key-2"
	tsInteropTokenTTL     = 300 * time.Second
)

type tsInteropStep struct {
	Step   string `json:"step"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
}

type tsInteropHarness struct {
	mu sync.Mutex

	apiKey        string
	agent         *content.Agent
	apiKeyRevoked bool

	realmKeys           map[string]*rsa.PrivateKey
	realmSigningKid     string
	projectedRealmKids  map[string]bool
	tokenDefect         string
	workloadKey         *rsa.PrivateKey
	otherKey            *rsa.PrivateKey
	candidateKey        *rsa.PrivateKey
	registeredClientKey *rsa.PublicKey

	active    content.KeycloakAgentWorkloadIdentity
	candidate content.KeycloakWorkloadTransitionCandidate

	seenAssertionJTIs map[string]bool
	violations        []string
	tokenExchanges    int
	acceptedRuntime   []string
	proofsVerified    int

	keycloak  *httptest.Server
	core      *httptest.Server
	router    http.Handler
	container do.Injector
}

func TestTypeScriptWorkloadInterop(t *testing.T) {
	scenarios := os.Getenv("OPENBOX_TS_INTEROP_SCENARIOS")
	if scenarios == "" {
		t.Skip("set OPENBOX_TS_INTEROP_SCENARIOS (see openbox-sdk-ts scripts/core-interop/run-core-workload-interop.mjs)")
	}
	sources := []string{content.WorkloadIdentitySourceOpenBox, content.WorkloadIdentitySourceOkta, content.WorkloadIdentitySourceEntra}
	for _, source := range sources {
		for _, scenario := range filepath.SplitList(scenarios) {
			runTSInteropScenario(t, source, scenario)
		}
	}
}

func runTSInteropScenario(t *testing.T, source, scenario string) {
	t.Run(source+"/"+filepath.Base(scenario), func(t *testing.T) {
		h := newTSInteropHarness(t, source)
		defer h.close()
		steps := h.runScenario(t, scenario)
		failed := 0
		for _, step := range steps {
			if !step.OK {
				failed++
				t.Errorf("step %s failed: %s", step.Step, step.Detail)
			} else {
				t.Logf("step %s ok: %s", step.Step, step.Detail)
			}
		}
		if len(steps) == 0 {
			t.Fatal("scenario reported no steps")
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		if len(h.violations) > 0 {
			t.Errorf("Keycloak isolation violations: %v", h.violations)
		}
		for _, accepted := range h.acceptedRuntime {
			if !strings.HasSuffix(accepted, h.agent.ID.String()) {
				t.Errorf("Core authenticated an unexpected agent: %s", accepted)
			}
		}
		t.Logf("summary: source=%s steps=%d failed=%d tokenExchanges=%d coreAcceptedRuntime=%d proofsVerified=%d",
			source, len(steps), failed, h.tokenExchanges, len(h.acceptedRuntime), h.proofsVerified)
	})
}

func newTSInteropHarness(t *testing.T, source string) *tsInteropHarness {
	t.Helper()
	h := &tsInteropHarness{
		apiKey:             "obx_test_" + strings.ReplaceAll(uuid.NewString(), "-", ""),
		realmKeys:          map[string]*rsa.PrivateKey{tsInteropRealmKid: tsInteropRSAKey(t), tsInteropNextRealmKid: tsInteropRSAKey(t)},
		realmSigningKid:    tsInteropRealmKid,
		projectedRealmKids: map[string]bool{tsInteropRealmKid: true},
		workloadKey:        tsInteropRSAKey(t),
		otherKey:           tsInteropRSAKey(t),
		candidateKey:       tsInteropRSAKey(t),
		seenAssertionJTIs:  map[string]bool{},
	}
	h.registeredClientKey = &h.workloadKey.PublicKey
	didMethod := content.AgentVerificationMethodOpenBoxDID
	h.agent = &content.Agent{
		ID:                 uuid.New(),
		OrganizationID:     "interop.openbox.test",
		AgentName:          "TypeScript interop agent",
		Status:             content.AgentStatusActive,
		VerificationMethod: &didMethod,
	}

	h.keycloak = httptest.NewServer(http.HandlerFunc(h.serveKeycloak))
	issuer := h.keycloak.URL + "/realms/openbox"
	h.active = content.KeycloakAgentWorkloadIdentity{
		ID:                    uuid.New(),
		OrganizationID:        h.agent.OrganizationID,
		OpenBoxAgentID:        h.agent.ID,
		Realm:                 "openbox",
		Issuer:                issuer,
		ClientID:              "interop-workload-client",
		ServiceAccountSubject: uuid.New(),
		SourceType:            source,
		ActivationVersion:     uuid.New(),
		Kid:                   "interop-workload-key",
	}
	h.candidate = content.KeycloakWorkloadTransitionCandidate{
		TransitionID:      uuid.New(),
		ServiceAccountID:  uuid.New(),
		OrganizationID:    h.agent.OrganizationID,
		OpenBoxAgentID:    h.agent.ID,
		Issuer:            issuer,
		ClientID:          "interop-candidate-client",
		ServiceAccountSub: uuid.New(),
		SourceType:        content.WorkloadIdentitySourceEntra,
		ActivationVersion: uuid.New(),
		Kid:               "interop-candidate-key",
		PublicJWK:         tsInteropPublicJWK(t, &h.candidateKey.PublicKey, "interop-candidate-key"),
		ExpiresAt:         time.Now().Add(10 * time.Minute),
	}

	store := &tsInteropWorkloadStore{h: h}
	transitions := &tsInteropTransitionStore{h: h}
	replays := &tsInteropReplay{seen: map[string]bool{}}
	container := do.New()
	do.Provide(container, func(do.Injector) (content.DatastoreAgent, error) {
		return &mockDatastoreAgent{findByTokenFunc: func(_ context.Context, hashed string) (*content.Agent, error) {
			h.mu.Lock()
			defer h.mu.Unlock()
			if h.apiKeyRevoked || hashed != services.HashAPIKey(h.apiKey) {
				return nil, errors.New("api key not found")
			}
			agent := *h.agent
			return &agent, nil
		}}, nil
	})
	do.Provide(container, func(i do.Injector) (*services.ServiceAgent, error) { return services.NewServiceAgent(i) })
	do.Provide(container, func(do.Injector) (content.DatastoreKeycloakWorkloadIdentity, error) { return store, nil })
	do.Provide(container, func(do.Injector) (*identity.KeycloakWorkloadTokenVerifier, error) {
		return identity.NewKeycloakWorkloadTokenVerifier(store, tsInteropAudience), nil
	})
	do.Provide(container, func(do.Injector) (*identity.KeycloakWorkloadTransitionProofVerifier, error) {
		return identity.NewKeycloakWorkloadTransitionProofVerifier(transitions, replays), nil
	})
	router, err := New(&Config{Container: container, Mode: "release", Origins: []string{"*"}})
	if err != nil {
		t.Fatalf("build Core router: %v", err)
	}
	h.container = container
	h.router = router
	h.core = httptest.NewServer(http.HandlerFunc(h.serveCore))
	return h
}

func (h *tsInteropHarness) close() {
	h.core.Close()
	h.keycloak.Close()
}

func (h *tsInteropHarness) tokenEndpoint() string {
	return h.keycloak.URL + "/realms/openbox/protocol/openid-connect/token"
}

// ── Keycloak token endpoint (controlled issuer) ────────────────────────────

func (h *tsInteropHarness) serveKeycloak(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r.Method != http.MethodPost || r.URL.Path != "/realms/openbox/protocol/openid-connect/token" {
		tsInteropJSON(w, http.StatusNotFound, map[string]any{"error": "not_found"})
		return
	}
	for name := range r.Header {
		lower := strings.ToLower(name)
		if lower == "authorization" || strings.HasPrefix(lower, "x-openbox") {
			h.violations = append(h.violations, "token request carried header "+name)
		}
	}
	body, _ := io.ReadAll(r.Body)
	if r.URL.RawQuery != "" {
		h.violations = append(h.violations, "token request carried a query")
	}
	form, err := parseTSInteropForm(string(body))
	if err != nil {
		tsInteropJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
		return
	}
	keys := make([]string, 0, len(form))
	for key := range form {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if strings.Join(keys, ",") != "client_assertion,client_assertion_type,client_id,grant_type" {
		h.violations = append(h.violations, "unexpected token form fields: "+strings.Join(keys, ","))
	}
	if form["grant_type"] != "client_credentials" ||
		form["client_assertion_type"] != "urn:ietf:params:oauth:client-assertion-type:jwt-bearer" ||
		form["client_id"] != h.active.ClientID {
		tsInteropJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_request"})
		return
	}
	if reason := h.verifyClientAssertion(form["client_assertion"]); reason != "" {
		tsInteropJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid_client", "error_description": reason})
		return
	}
	h.tokenExchanges++
	tsInteropJSON(w, http.StatusOK, map[string]any{
		"access_token": h.mintAccessToken(),
		"token_type":   "Bearer",
		"expires_in":   int(tsInteropTokenTTL.Seconds()),
	})
}

// verifyClientAssertion applies the RFC 7523 checks Keycloak's signed-JWT
// client authenticator performs, against the key registered for the client.
func (h *tsInteropHarness) verifyClientAssertion(assertion string) string {
	claims := jwt.MapClaims{}
	token, err := jwt.NewParser(
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(h.active.ClientID),
		jwt.WithSubject(h.active.ClientID),
		jwt.WithAudience(h.tokenEndpoint()),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(time.Minute),
	).ParseWithClaims(assertion, claims, func(*jwt.Token) (any, error) { return h.registeredClientKey, nil })
	if err != nil || !token.Valid {
		return fmt.Sprintf("assertion rejected: %v", err)
	}
	if kid, _ := token.Header["kid"].(string); kid != h.active.Kid {
		return "assertion kid does not name the registered client key"
	}
	if typ, _ := token.Header["typ"].(string); typ != "JWT" {
		return "assertion typ is not JWT"
	}
	iat, _ := claims.GetIssuedAt()
	exp, _ := claims.GetExpirationTime()
	if iat == nil || exp == nil || exp.Sub(iat.Time) > time.Minute {
		return "assertion lifetime exceeds one minute"
	}
	jti, _ := claims["jti"].(string)
	if jti == "" || h.seenAssertionJTIs[jti] {
		return "assertion jti missing or replayed"
	}
	h.seenAssertionJTIs[jti] = true
	return ""
}

// mintAccessToken issues a realm-signed token with Keycloak's claim layout and
// the OpenBox mapper claims Core's verifier compares with the active authority.
func (h *tsInteropHarness) mintAccessToken() string {
	now := time.Now()
	claims := jwt.MapClaims{
		"iss":                        h.active.Issuer,
		"sub":                        h.active.ServiceAccountSubject.String(),
		"aud":                        []string{tsInteropAudience},
		"azp":                        h.active.ClientID,
		"iat":                        now.Unix(),
		"exp":                        now.Add(tsInteropTokenTTL).Unix(),
		"jti":                        uuid.NewString(),
		"typ":                        "Bearer",
		"openbox_organization_id":    h.active.OrganizationID,
		"openbox_agent_id":           h.active.OpenBoxAgentID.String(),
		"openbox_service_account_id": h.active.ID.String(),
		"openbox_activation_version": h.active.ActivationVersion.String(),
		"openbox_identity_source":    h.active.SourceType,
	}
	// A scenario can ask for exactly one defect Core's verifier must reject.
	switch h.tokenDefect {
	case "wrong-audience":
		claims["aud"] = []string{"another-service"}
	case "wrong-issuer":
		claims["iss"] = h.active.Issuer + "-impostor"
	case "expired":
		claims["iat"] = now.Add(-5 * time.Minute).Unix()
		claims["exp"] = now.Add(-2 * time.Minute).Unix()
	case "wrong-source":
		if h.active.SourceType == content.WorkloadIdentitySourceEntra {
			claims["openbox_identity_source"] = content.WorkloadIdentitySourceOkta
		} else {
			claims["openbox_identity_source"] = content.WorkloadIdentitySourceEntra
		}
	case "wrong-agent":
		claims["openbox_agent_id"] = uuid.NewString()
	case "wrong-organization":
		claims["openbox_organization_id"] = "another.organization"
	case "wrong-activation":
		claims["openbox_activation_version"] = uuid.NewString()
	case "wrong-subject":
		claims["sub"] = uuid.NewString()
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = h.realmSigningKid
	signed, err := token.SignedString(h.realmKeys[h.realmSigningKid])
	if err != nil {
		panic(err)
	}
	return signed
}

// ── Core ───────────────────────────────────────────────────────────────────

func (h *tsInteropHarness) serveCore(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/__interop/control":
		h.control(w, r)
	case "/api/v3/governance/evaluate", "/api/v3/governance/approval", "/api/v3/handoffs":
		h.governed(w, r)
	default:
		h.router.ServeHTTP(w, r)
	}
}

// governed authenticates with Core's real v3 runtime authentication, then
// answers with a deterministic business response.
func (h *tsInteropHarness) governed(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(body))
	c := echo.New().NewContext(r, w)
	agent, err := authenticateRuntimeAgent(r.Context(), h.container, c, bearerTokenFromHeader(r.Header.Get("Authorization")), body, 3)
	if err != nil {
		if isAuthInfrastructureError(err) {
			tsInteropJSON(w, http.StatusInternalServerError, map[string]any{"code": 500, "message": "internal server error"})
			return
		}
		tsInteropJSON(w, http.StatusUnauthorized, map[string]any{"code": 401, "message": "invalid token or agent identity"})
		return
	}
	h.mu.Lock()
	h.acceptedRuntime = append(h.acceptedRuntime, r.URL.Path+" "+agent.ID.String())
	h.mu.Unlock()

	var payload map[string]any
	_ = json.Unmarshal(body, &payload)
	switch r.URL.Path {
	case "/api/v3/governance/evaluate":
		if payload["event_type"] == "Handoff" {
			tsInteropJSON(w, http.StatusBadRequest, map[string]any{"code": 400, "message": "use POST /api/v3/handoffs"})
			return
		}
		verdict := "allow"
		if payload["activity_type"] == "danger" {
			verdict = "block"
		}
		tsInteropJSON(w, http.StatusOK, map[string]any{"verdict": verdict, "reason": "interop policy"})
	case "/api/v3/governance/approval":
		tsInteropJSON(w, http.StatusOK, map[string]any{"action": "allow"})
	default:
		target, _ := payload["target_agent_id"].(string)
		tsInteropJSON(w, http.StatusOK, map[string]any{
			"handoff_id": uuid.NewString(), "from_agent_id": agent.ID.String(), "to_agent_id": target,
		})
	}
}

// control lets a scenario change server-side authority while its client lives.
func (h *tsInteropHarness) control(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	action := r.URL.Query().Get("action")
	switch action {
	case "rotate-activation":
		h.active.ActivationVersion = uuid.New()
	case "register-other-key":
		h.registeredClientKey = &h.otherKey.PublicKey
	case "expire-candidate":
		h.candidate.ExpiresAt = time.Now().Add(-time.Minute)
	case "revoke-api-key":
		h.apiKeyRevoked = true
	case "token-defect":
		h.tokenDefect = r.URL.Query().Get("defect")
	case "rotate-realm-key":
		// Keycloak starts signing with a key Core has not projected yet.
		h.realmSigningKid = tsInteropNextRealmKid
	case "project-realm-key":
		h.projectedRealmKids[tsInteropNextRealmKid] = true
	default:
		tsInteropJSON(w, http.StatusBadRequest, map[string]any{"error": "unknown action"})
		return
	}
	tsInteropJSON(w, http.StatusOK, map[string]any{"ok": true, "activation_version": h.active.ActivationVersion.String()})
}

// ── Node scenario ──────────────────────────────────────────────────────────

func (h *tsInteropHarness) runScenario(t *testing.T, scenario string) []tsInteropStep {
	t.Helper()
	cmd := exec.Command("node", scenario)
	cmd.Dir = os.Getenv("OPENBOX_TS_INTEROP_NODE_CWD")
	cmd.Env = append(os.Environ(),
		"INTEROP_CORE_URL="+h.core.URL,
		"INTEROP_CONTROL_URL="+h.core.URL+"/__interop/control",
		"INTEROP_API_KEY="+h.apiKey,
		"INTEROP_WORKLOAD_PRIVATE_KEY="+tsInteropPEM(t, h.workloadKey),
		"INTEROP_CANDIDATE_PRIVATE_KEY="+tsInteropPEM(t, h.candidateKey),
		"INTEROP_TRANSITION_ID="+h.candidate.TransitionID.String(),
		"INTEROP_AGENT_ID="+h.agent.ID.String(),
		"INTEROP_TOKEN_ENDPOINT="+h.tokenEndpoint(),
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		t.Fatalf("scenario %s failed: %v\nstderr:\n%s\nstdout:\n%s", scenario, err, stderr.String(), stdout.String())
	}
	var steps []tsInteropStep
	for _, line := range strings.Split(stdout.String(), "\n") {
		if strings.HasPrefix(line, "INTEROP_RESULT ") {
			if err := json.Unmarshal([]byte(strings.TrimPrefix(line, "INTEROP_RESULT ")), &steps); err != nil {
				t.Fatalf("parse scenario result: %v", err)
			}
		}
	}
	if stderr.Len() > 0 {
		t.Logf("scenario stderr:\n%s", stderr.String())
	}
	return steps
}

// ── datastores ─────────────────────────────────────────────────────────────

type tsInteropWorkloadStore struct{ h *tsInteropHarness }

func (s *tsInteropWorkloadStore) ResolveActive(_ context.Context, organizationID string, agentID uuid.UUID) (*content.KeycloakAgentWorkloadIdentity, error) {
	s.h.mu.Lock()
	defer s.h.mu.Unlock()
	if s.h.active.OrganizationID != organizationID || s.h.active.OpenBoxAgentID != agentID {
		return nil, nil
	}
	active := s.h.active
	return &active, nil
}

func (s *tsInteropWorkloadStore) ResolveVerificationAuthority(_ context.Context, organizationID string, agentID uuid.UUID, kid string, _ time.Time) (*content.KeycloakWorkloadVerificationAuthority, error) {
	s.h.mu.Lock()
	defer s.h.mu.Unlock()
	key, known := s.h.realmKeys[kid]
	if s.h.active.OrganizationID != organizationID || s.h.active.OpenBoxAgentID != agentID || !known || !s.h.projectedRealmKids[kid] {
		return nil, nil
	}
	jwk, err := tsInteropJWKJSON(&key.PublicKey, kid)
	if err != nil {
		return nil, err
	}
	return &content.KeycloakWorkloadVerificationAuthority{Identity: s.h.active, KeyKid: kid, KeyAlg: "RS256", PublicJWK: jwk}, nil
}

type tsInteropTransitionStore struct{ h *tsInteropHarness }

func (s *tsInteropTransitionStore) ResolveCandidate(_ context.Context, organizationID string, agentID, transitionID uuid.UUID) (*content.KeycloakWorkloadTransitionCandidate, error) {
	s.h.mu.Lock()
	defer s.h.mu.Unlock()
	if s.h.candidate.OrganizationID != organizationID || s.h.candidate.OpenBoxAgentID != agentID || s.h.candidate.TransitionID != transitionID {
		return nil, nil
	}
	candidate := s.h.candidate
	return &candidate, nil
}

func (s *tsInteropTransitionStore) MarkProofVerified(_ context.Context, _ string, _, transitionID, serviceAccountID uuid.UUID, _ string, _ time.Time) (bool, error) {
	s.h.mu.Lock()
	defer s.h.mu.Unlock()
	if transitionID != s.h.candidate.TransitionID || serviceAccountID != s.h.candidate.ServiceAccountID {
		return false, nil
	}
	s.h.proofsVerified++
	return true, nil
}

type tsInteropReplay struct {
	mu   sync.Mutex
	seen map[string]bool
}

func (r *tsInteropReplay) ClaimOnce(_ context.Context, key string, _ time.Duration) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.seen[key] {
		return false, nil
	}
	r.seen[key] = true
	return true, nil
}

// ── helpers ────────────────────────────────────────────────────────────────

func tsInteropRSAKey(t *testing.T) *rsa.PrivateKey {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}
	return key
}

func tsInteropPEM(t *testing.T, key *rsa.PrivateKey) string {
	t.Helper()
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatalf("marshal PKCS8: %v", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

func tsInteropJWKJSON(key *rsa.PublicKey, kid string) (json.RawMessage, error) {
	return json.Marshal(map[string]any{
		"kty": "RSA", "kid": kid, "alg": "RS256", "use": "sig",
		"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		"e": base64.RawURLEncoding.EncodeToString(big.NewInt(int64(key.E)).Bytes()),
	})
}

func tsInteropPublicJWK(t *testing.T, key *rsa.PublicKey, kid string) json.RawMessage {
	t.Helper()
	raw, err := tsInteropJWKJSON(key, kid)
	if err != nil {
		t.Fatalf("marshal JWK: %v", err)
	}
	return raw
}

func parseTSInteropForm(body string) (map[string]string, error) {
	parsed, err := url.ParseQuery(body)
	if err != nil {
		return nil, err
	}
	values := map[string]string{}
	for key, all := range parsed {
		if len(all) != 1 {
			return nil, fmt.Errorf("form field %s appears %d times", key, len(all))
		}
		values[key] = all[0]
	}
	return values, nil
}

func tsInteropJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
