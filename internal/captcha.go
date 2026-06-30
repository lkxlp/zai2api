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
		return "", fmt.Errorf("请求验证码服务失败: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("读取验证码服务响应失败: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("验证码服务状态 %d: %s", resp.StatusCode, string(body)[:min(200, len(body))])
	}

	var result captchaProviderResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return "", fmt.Errorf("解析验证码服务响应失败: %w", err)
	}

	if !result.OK {
		return "", fmt.Errorf("验证码服务错误: %s", result.Error)
	}

	return result.Token, nil
}
