// Command orbitctl lists and completes Orbit tasks from a terminal.
//
//	orbitctl list [-status todo]
//	orbitctl done <task-id>
package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"text/tabwriter"
	"time"
)

type Task struct {
	ID       string   `json:"id"`
	Title    string   `json:"title"`
	Status   string   `json:"status"`
	Priority string   `json:"priority"`
	Tags     []string `json:"tags"`
	DueDate  *string  `json:"dueDate"`
}

type page struct {
	Items      []Task  `json:"items"`
	NextCursor *string `json:"nextCursor"`
}

type client struct {
	baseURL string
	token   string
	http    *http.Client
}

func newClient() *client {
	baseURL := os.Getenv("ORBIT_URL")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:4180"
	}
	return &client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   os.Getenv("ORBIT_API_TOKEN"),
		http:    &http.Client{Timeout: 10 * time.Second},
	}
}

func (c *client) do(method, path string, body any, out any) error {
	var payload bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&payload).Encode(body); err != nil {
			return err
		}
	}
	req, err := http.NewRequest(method, c.baseURL+path, &payload)
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	if c.token != "" {
		req.Header.Set("authorization", "Bearer "+c.token)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("orbit is not reachable at %s: %w", c.baseURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("%s %s: %s", method, path, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

func list(c *client, args []string) error {
	flags := flag.NewFlagSet("list", flag.ExitOnError)
	status := flags.String("status", "todo", "only show tasks with this status")
	_ = flags.Parse(args)

	var result page
	if err := c.do(http.MethodGet, "/api/tasks?status="+*status, nil, &result); err != nil {
		return err
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, "ID\tPRIORITY\tDUE\tTITLE")
	for _, task := range result.Items {
		due := "-"
		if task.DueDate != nil {
			due = *task.DueDate
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", task.ID, task.Priority, due, task.Title)
	}
	return w.Flush()
}

func done(c *client, args []string) error {
	if len(args) != 1 {
		return errors.New("usage: orbitctl done <task-id>")
	}
	var task Task
	if err := c.do(http.MethodPatch, "/api/tasks/"+args[0], map[string]string{"status": "done"}, &task); err != nil {
		return err
	}
	fmt.Printf("Completed %s: %s\n", task.ID, task.Title)
	return nil
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: orbitctl <list|done> [arguments]")
		os.Exit(2)
	}
	c := newClient()
	var err error
	switch os.Args[1] {
	case "list":
		err = list(c, os.Args[2:])
	case "done":
		err = done(c, os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "orbitctl:", err)
		os.Exit(1)
	}
}
