package internal

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	fhttp "github.com/bogdanfinn/fhttp"
	"github.com/google/uuid"
)

// AgentSession Agent 模式会话状态：z.ai 颁发的 chat_id + user message id
type AgentSession struct {
	ChatID    string
	UserMsgID string
}

// CreateAgentChat 调用 /api/v1/chats/new 创建一个 general_agent 类型的 chat
// 返回 z.ai 颁发的 chat_id 和 user_message_id
func CreateAgentChat(token string, userContent string, model string) (*AgentSession, error) {
	userMsgID := uuid.New().String()
	timestamp := time.Now().Unix()
	timestampMs := time.Now().UnixMilli()

	// 严格按 z.ai 抓包格式构造 body
	body := map[string]interface{}{
		"chat": map[string]interface{}{
			"id":     "",
			"title":  "新聊天",
			"models": []string{model},
			"params": map[string]interface{}{},
			"history": map[string]interface{}{
				"messages": map[string]interface{}{
					userMsgID: map[string]interface{}{
						"id":          userMsgID,
						"parentId":    nil,
						"childrenIds": []string{},
						"role":        "user",
						"content":     userContent,
						"timestamp":   timestamp,
						"models":      []string{model},
					},
				},
				"currentId": userMsgID,
			},
			"tags":  []string{},
			"flags": []string{"general_agent"},
			"features": []map[string]string{
				{"server": "web_search_h", "status": "hidden", "type": "web_search"},
				{"server": "tool_selector_h", "status": "hidden", "type": "tool_selector"},
				{"server": "hidden-thinking", "status": "hidden", "type": "hidden-thinking"},
			},
			"mcp_servers":      []string{},
			"enable_thinking":  true,
			"auto_web_search":  false,
			"message_version":  1,
			"extra":            map[string]interface{}{},
			"timestamp":        timestampMs,
			"type":             "general_agent",
		},
	}

	bodyBytes, _ := json.Marshal(body)
	url := strings.TrimRight(Cfg.APIEndpoint, "/")
	// APIEndpoint 通常是 https://chat.z.ai/api/v2/chat/completions，截到 https://chat.z.ai
	url = strings.Replace(url, "/api/v2/chat/completions", "/api/v1/chats/new", 1)

	req, err := fhttp.NewRequest("POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("build req: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Origin", "https://chat.z.ai")
	req.Header.Set("Referer", "https://chat.z.ai/")
	req.Header.Set("X-FE-Version", GetFeVersion())
	ApplyBrowserFingerprintHeaders(req.Header)

	client, err := TLSHTTPClient(30 * time.Second)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("post chats/new: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("chats/new status %d: %s", resp.StatusCode, string(respBody)[:min(300, len(respBody))])
	}

	var parsed struct {
		ID   string `json:"id"`
		Type string `json:"type"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("parse chats/new response: %w", err)
	}
	if parsed.ID == "" {
		return nil, fmt.Errorf("chats/new returned empty chat_id")
	}
	LogDebug("[AgentMode] Created chat: id=%s, type=%s", parsed.ID, parsed.Type)
	return &AgentSession{ChatID: parsed.ID, UserMsgID: userMsgID}, nil
}

// InitWorkspace 调用 /api/v1/web-dev/workspaces/up 初始化 agent workspace
// 这一步是 agent 模式 chat completions 成功的必要前提
func InitWorkspace(token string, chatID string) error {
	body := map[string]interface{}{
		"chatId": chatID,
		"flags":  []string{"general_agent"},
	}
	bodyBytes, _ := json.Marshal(body)

	url := strings.TrimRight(Cfg.APIEndpoint, "/")
	url = strings.Replace(url, "/api/v2/chat/completions", "/api/v1/web-dev/workspaces/up", 1)

	req, err := fhttp.NewRequest("POST", url, bytes.NewReader(bodyBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://chat.z.ai")
	req.Header.Set("Referer", "https://chat.z.ai/")
	req.Header.Set("X-FE-Version", GetFeVersion())
	ApplyBrowserFingerprintHeaders(req.Header)

	client, err := TLSHTTPClient(30 * time.Second)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("workspace/up: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("workspace/up status %d: %s", resp.StatusCode, string(respBody)[:min(200, len(respBody))])
	}
	LogDebug("[AgentMode] Workspace initialized for chat %s", chatID)
	return nil
}

// PrepareAgentSession 完整完成 agent 模式准备：建 chat → 初始化 workspace
func PrepareAgentSession(token string, userContent string, model string) (*AgentSession, error) {
	session, err := CreateAgentChat(token, userContent, model)
	if err != nil {
		return nil, fmt.Errorf("create agent chat: %w", err)
	}
	if err := InitWorkspace(token, session.ChatID); err != nil {
		// workspace 失败不阻塞，因为简单查询可能也能工作
		LogWarn("[AgentMode] InitWorkspace failed (continuing): %v", err)
	}
	return session, nil
}
