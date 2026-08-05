class Acmos < Formula
  desc "Multi-format AI proxy with combo virtual providers"
  homepage "https://github.com/charlzyx/acmos"
  url "https://github.com/charlzyx/acmos/releases/download/v0.1.12/acmos"
  sha256 "ec7ae9ba10c5b4b0ac71db2a5c634c5bf4915e7df3e3bfc5c1d6de3359e9629d"
  license "MIT"

  def install
    bin.install "acmos"
  end

  def post_install
    (var/"acmos").mkpath
    (var/"acmos/logs").mkpath
  end

  service do
    run [opt_bin/"acmos", "serve"]
    environment_variables ACMOS_HOME: var/"acmos"
    keep_alive true
    log_path var/"acmos/logs/stdout.log"
    error_log_path var/"acmos/logs/stderr.log"
  end

  test do
    assert_match "0.1.12", shell_output("#{bin}/acmos --version")
  end
end
