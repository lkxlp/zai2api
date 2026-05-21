package internal

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type captchaProviderResponse struct {
	OK    bool   `json:"ok"`
	Token string `json:"token"`
	Error string `json:"error"`
}

// fetchCaptchaToken 从 captcha provider 服务获取验证码 token
func fetchCaptchaToken() (string, error) {
	if Cfg.CaptchaProviderURL == "" {
		return "", nil
	}

	url := strings.TrimRight(Cfg.CaptchaProviderURL, "/") + "/token"

	client := &http.Client{Timeout: 35 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return "", fmt.Errorf("captcha provider request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("captcha provider read body failed: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("captcha provider status %d: %s", resp.StatusCode, string(body)[:min(200, len(body))])
	}

	var result captchaProviderResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("captcha provider decode failed: %w", err)
	}

	if !result.OK {
		return "", fmt.Errorf("captcha provider error: %s", result.Error)
	}

	return result.Token, nil
}
