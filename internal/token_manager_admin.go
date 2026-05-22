package internal

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// AddToken 添加一个 token 到 TokenManager 并写入 data/tokens.txt
// 写入文件后 fsnotify 会触发 reload，但我们这里同步更新内存以避免短暂窗口
func (tm *TokenManager) AddToken(token string) (*TokenInfo, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, fmt.Errorf("token 为空")
	}
	if strings.HasPrefix(token, "token=") {
		token = strings.TrimPrefix(token, "token=")
	}

	// JWT 校验
	payload, err := DecodeJWTPayload(token)
	if err != nil || payload == nil {
		return nil, fmt.Errorf("无效的 JWT token，请检查格式（应以 eyJ 开头）")
	}

	tm.mu.Lock()
	if _, exists := tm.tokens[token]; exists {
		tm.mu.Unlock()
		return nil, fmt.Errorf("token 已存在")
	}

	info := &TokenInfo{
		Token:  token,
		Email:  payload.Email,
		UserID: payload.ID,
		Valid:  true,
	}
	tm.tokens[token] = info
	tm.validTokens = append(tm.validTokens, token)
	tm.mu.Unlock()

	// 异步验证有效性（后台）
	go func() {
		valid := tm.validateToken(token)
		tm.mu.Lock()
		if t, ok := tm.tokens[token]; ok {
			t.Valid = valid
		}
		if !valid {
			tm.rebuildValidTokensLocked()
		}
		tm.mu.Unlock()
	}()

	// 写入文件（不持锁，因为 writeTokensToFile 自己会读快照）
	if err := tm.writeTokensToFile(); err != nil {
		LogWarn("写入 tokens.txt 失败: %v", err)
	}

	invalidateAnonymousPoolSlots()
	return info, nil
}

// RemoveToken 从 TokenManager 删除一个 token，并更新文件
func (tm *TokenManager) RemoveToken(token string) error {
	tm.mu.Lock()
	if _, exists := tm.tokens[token]; !exists {
		tm.mu.Unlock()
		return fmt.Errorf("token 不存在")
	}
	delete(tm.tokens, token)
	tm.rebuildValidTokensLocked()
	tm.mu.Unlock()

	if err := tm.writeTokensToFile(); err != nil {
		return fmt.Errorf("写入文件失败: %v", err)
	}
	return nil
}

// ListTokens 返回当前所有 token 的快照
func (tm *TokenManager) ListTokens() []*TokenInfo {
	tm.mu.RLock()
	defer tm.mu.RUnlock()
	out := make([]*TokenInfo, 0, len(tm.tokens))
	for _, info := range tm.tokens {
		// 复制一份避免被外部修改
		copy := *info
		out = append(out, &copy)
	}
	return out
}

// ValidateTokenNow 立即验证某个 token 的有效性，返回最新状态
func (tm *TokenManager) ValidateTokenNow(token string) (bool, error) {
	tm.mu.RLock()
	_, exists := tm.tokens[token]
	tm.mu.RUnlock()
	if !exists {
		return false, fmt.Errorf("token 不存在")
	}

	valid := tm.validateToken(token)

	tm.mu.Lock()
	if t, ok := tm.tokens[token]; ok {
		t.Valid = valid
	}
	tm.rebuildValidTokensLocked()
	tm.mu.Unlock()
	return valid, nil
}

// rebuildValidTokensLocked 重建 validTokens 列表（必须在已持锁状态下调用）
func (tm *TokenManager) rebuildValidTokensLocked() {
	tm.validTokens = tm.validTokens[:0]
	for token, info := range tm.tokens {
		if info.Valid {
			tm.validTokens = append(tm.validTokens, token)
		}
	}
}

// writeTokensToFile 把当前所有 token 写入 data/tokens.txt
// 临时文件 + rename 保证原子性
func (tm *TokenManager) writeTokensToFile() error {
	tm.mu.RLock()
	tokens := make([]string, 0, len(tm.tokens))
	for tk := range tm.tokens {
		tokens = append(tokens, tk)
	}
	tm.mu.RUnlock()

	tokenFile := filepath.Join(tm.dataDir, "tokens.txt")
	if err := os.MkdirAll(tm.dataDir, 0755); err != nil {
		return err
	}

	var sb strings.Builder
	sb.WriteString("# 用户 Token 文件 (由管理后台维护，可手动编辑)\n")
	sb.WriteString("# 每行一个 JWT token\n\n")
	for _, t := range tokens {
		sb.WriteString(t)
		sb.WriteString("\n")
	}

	tmpFile := tokenFile + ".tmp"
	if err := os.WriteFile(tmpFile, []byte(sb.String()), 0644); err != nil {
		return err
	}
	return os.Rename(tmpFile, tokenFile)
}
