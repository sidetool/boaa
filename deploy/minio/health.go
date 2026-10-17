// SPDX-License-Identifier: MIT
// Copyright (c) BOAA contributors.
package main

import (
 "net/http"
 "os"
 "time"
)

func main() {
 client := &http.Client{Timeout: 4 * time.Second, Transport: &http.Transport{Proxy: nil}}
 response, err := client.Get("http://127.0.0.1:9000/minio/health/live")
 if err != nil { os.Exit(1) }
 defer response.Body.Close()
 if response.StatusCode != http.StatusOK { os.Exit(1) }
}
