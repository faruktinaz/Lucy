package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDoSendsTokenAndDecodesResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("authorization"); got != "Bearer local-test-token" {
			t.Errorf("authorization header = %q", got)
		}
		_ = json.NewEncoder(w).Encode(Task{ID: "tsk_0007", Title: "Ship it", Status: "done"})
	}))
	defer server.Close()

	c := &client{baseURL: server.URL, token: "local-test-token", http: server.Client()}
	var task Task
	if err := c.do(http.MethodPatch, "/api/tasks/tsk_0007", map[string]string{"status": "done"}, &task); err != nil {
		t.Fatalf("do returned an error: %v", err)
	}
	if task.Status != "done" {
		t.Errorf("status = %q, want done", task.Status)
	}
}

func TestDoReportsHTTPErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "missing", http.StatusNotFound)
	}))
	defer server.Close()

	c := &client{baseURL: server.URL, http: server.Client()}
	var task Task
	if err := c.do(http.MethodGet, "/api/tasks/unknown", nil, &task); err == nil {
		t.Fatal("expected an error for a 404 response")
	}
}
