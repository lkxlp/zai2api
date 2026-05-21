package internal

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
)

const anonymousAuthURL = "https://chat.z.ai/api/v1/auths/"

type AnonymousAuthResponse struct {
	Token string `json:"token"`
}

// UpstreamZaiCredentialConfigured 已配置 z.ai 上游凭证（TokenManager 有效 token 或 BACKUP_TOKEN）时返回 true，此时不维护匿名 token 池，GetAnonymousToken 每次直连拉取。
func UpstreamZaiCredentialConfigured() bool {
	if Cfg == nil {
		return false
	}
	if len(Cfg.BackupTokens) > 0 {
		return true
	}
	return GetTokenManager().HasValidUpstreamTokens()
}

type anonPoolSlot struct {
	token   string
	expires time.Time
}

var (
	anonPoolMu    sync.Mutex
	anonPoolSlots []anonPoolSlot
	anonPoolNext  int
	poolTTL       time.Duration
	refreshEvery  time.Duration
	maxRetries    int
	poolOnce      sync.Once
)

// StartAnonymousTokenPool 启动后台周期性补全匿名 token 池；无上游 token 时预取，有上游 token 时清空池且不预取。
func StartAnonymousTokenPool() {
	poolOnce.Do(func() {
		size := 4
		if Cfg != nil && Cfg.AnonymousPoolSize > 0 {
			size = Cfg.AnonymousPoolSize
		}
		if size < 1 {
			size = 1
		}
		if size > 16 {
			size = 16
		}
		poolTTL = 20 * time.Minute
		if Cfg != nil && Cfg.AnonymousTokenTTLSeconds > 0 {
			poolTTL = time.Duration(Cfg.AnonymousTokenTTLSeconds) * time.Second
		}
		if poolTTL < 5*time.Minute {
			poolTTL = 5 * time.Minute
		}
		refreshEvery = 90 * time.Second
		if Cfg != nil && Cfg.AnonymousRefreshIntervalSeconds > 0 {
			refreshEvery = time.Duration(Cfg.AnonymousRefreshIntervalSeconds) * time.Second
		}
		if refreshEvery < 30*time.Second {
			refreshEvery = 30 * time.Second
		}
		maxRetries = 3
		if Cfg != nil && Cfg.AnonymousFetchMaxRetries > 0 {
			maxRetries = Cfg.AnonymousFetchMaxRetries
		}
		if maxRetries > 8 {
			maxRetries = 8
		}

		anonPoolMu.Lock()
		anonPoolSlots = make([]anonPoolSlot, size)
		anonPoolNext = 0
		anonPoolMu.Unlock()

		go anonymousPoolLoop()
		LogInfo("匿名 token 池已启动: size=%d ttl=%v refresh=%v", size, poolTTL, refreshEvery)
	})
}

func anonymousPoolLoop() {
	refillAnonymousPool()
	ticker := time.NewTicker(refreshEvery)
	defer ticker.Stop()
	for range ticker.C {
		refillAnonymousPool()
	}
}

// invalidateAnonymousPoolSlots 清空池中条目（例如 TokenManager 刚加载到有效 token 时）
func invalidateAnonymousPoolSlots() {
	anonPoolMu.Lock()
	defer anonPoolMu.Unlock()
	if len(anonPoolSlots) == 0 {
		return
	}
	for i := range anonPoolSlots {
		anonPoolSlots[i] = anonPoolSlot{}
	}
}

func refillAnonymousPool() {
	if UpstreamZaiCredentialConfigured() {
		anonPoolMu.Lock()
		for i := range anonPoolSlots {
			anonPoolSlots[i] = anonPoolSlot{}
		}
		anonPoolMu.Unlock()
		return
	}
	for i := range anonPoolSlots {
		need := false
		anonPoolMu.Lock()
		if i < len(anonPoolSlots) {
			s := &anonPoolSlots[i]
			if s.token == "" || time.Now().After(s.expires) {
				need = true
			}
		}
		anonPoolMu.Unlock()
		if !need {
			continue
		}
		tok, exp, err := fetchAnonymousTokenOnce()
		if err != nil {
			LogDebug("[anon-pool] slot %d: %v", i, err)
			time.Sleep(250 * time.Millisecond)
			continue
		}
		anonPoolMu.Lock()
		if !UpstreamZaiCredentialConfigured() && i < len(anonPoolSlots) {
			anonPoolSlots[i] = anonPoolSlot{token: tok, expires: exp}
		}
		anonPoolMu.Unlock()
	}
}

// GetUpstreamTokenForModelAPI 拉模型列表等：优先 TokenManager / BACKUP，否则匿名（可走池）。
func GetUpstreamTokenForModelAPI() (string, error) {
	if t := GetTokenManager().GetToken(); t != "" {
		return t, nil
	}
	if t := GetBackupToken(); t != "" {
		return t, nil
	}
	return GetAnonymousToken()
}

// GetAnonymousToken 返回用于 z.ai 上游的匿名 token：已配置上游 token 时每次直连；否则从池 next 轮询取用，池空或过期则临时直连拉取。
func GetAnonymousToken() (string, error) {
	if UpstreamZaiCredentialConfigured() {
		tok, _, err := fetchAnonymousTokenOnce()
		return tok, err
	}
	StartAnonymousTokenPool()

	anonPoolMu.Lock()
	n := len(anonPoolSlots)
	if n == 0 {
		anonPoolMu.Unlock()
		tok, _, err := fetchAnonymousTokenOnce()
		return tok, err
	}
	now := time.Now()
	for attempt := 0; attempt < n; attempt++ {
		idx := (anonPoolNext + attempt) % n
		s := &anonPoolSlots[idx]
		if s.token != "" && now.Before(s.expires) {
			tok := s.token
			anonPoolNext = (idx + 1) % n
			anonPoolMu.Unlock()
			return tok, nil
		}
	}
	anonPoolMu.Unlock()

	tok, _, err := fetchAnonymousTokenOnce()
	return tok, err
}

func jwtExpiryIfAny(token string) (time.Time, bool) {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return time.Time{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}, false
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(raw, &claims); err != nil || claims.Exp == 0 {
		return time.Time{}, false
	}
	return time.Unix(claims.Exp, 0), true
}

func computeAnonTokenExpiry(token string) time.Time {
	now := time.Now()
	ttl := poolTTL
	if ttl < 5*time.Minute {
		if Cfg != nil && Cfg.AnonymousTokenTTLSeconds > 0 {
			ttl = time.Duration(Cfg.AnonymousTokenTTLSeconds) * time.Second
		}
		if ttl < 5*time.Minute {
			ttl = 20 * time.Minute
		}
	}
	byTTL := now.Add(ttl)
	if jwtExp, ok := jwtExpiryIfAny(token); ok {
		jwtCut := jwtExp.Add(-90 * time.Second)
		if jwtCut.Before(now.Add(2 * time.Minute)) {
			return byTTL
		}
		if jwtCut.Before(byTTL) {
			return jwtCut
		}
	}
	return byTTL
}

func fetchAnonymousTokenOnce() (token string, expires time.Time, err error) {
	var lastErr error
	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			time.Sleep(time.Duration(200*(attempt+1)) * time.Millisecond)
		}
		tok, e := fetchAnonymousTokenHTTP()
		if e == nil && tok != "" {
			return tok, computeAnonTokenExpiry(tok), nil
		}
		lastErr = e
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("empty token")
	}
	return "", time.Time{}, lastErr
}

func fetchAnonymousTokenHTTP() (string, error) {
	client, err := TLSHTTPClient(15 * time.Second)
	if err != nil {
		return "", err
	}
	req, err := fhttp.NewRequest("GET", anonymousAuthURL, nil)
	if err != nil {
		return "", err
	}
	ApplyBrowserFingerprintHeaders(req.Header)
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
	req.Header.Set("Referer", "https://chat.z.ai/")
	req.Header.Set("Origin", "https://chat.z.ai")
	req.Header.Set("Sec-Fetch-Dest", "empty")
	req.Header.Set("Sec-Fetch-Mode", "cors")
	req.Header.Set("Sec-Fetch-Site", "same-origin")

	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		preview := string(body)
		if len(preview) > 200 {
			preview = preview[:200] + "..."
		}
		return "", fmt.Errorf("status %d: %s", resp.StatusCode, preview)
	}
	var authResp AnonymousAuthResponse
	if err := json.Unmarshal(body, &authResp); err != nil {
		return "", fmt.Errorf("decode: %w", err)
	}
	if authResp.Token == "" {
		return "", fmt.Errorf("empty token in response")
	}
	return authResp.Token, nil
}
