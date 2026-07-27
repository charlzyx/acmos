class Acmos < Formula
  desc "Multi-format AI proxy with combo virtual providers"
  homepage "https://github.com/charlzyx/acmos"
  url "https://github.com/charlzyx/acmos/releases/download/v0.1.0/acmos"
  sha256 "884a780004e3890c0b56cd200602df56f57fbc934c63ba6e677b6f7e2d801fab"
  license "MIT"

  def install
    bin.install "acmos"
  end

  def post_install
    (var/"acmos").mkpath
    (var/"acmos/logs").mkpath
  end

  service do
    run [opt_bin/"acmos"]
    environment_variables ACMOS_HOME: var/"acmos"
    keep_alive true
    log_path var/"acmos/logs/stdout.log"
    error_log_path var/"acmos/logs/stderr.log"
  end

  test do
    assert_match "0.1.0", shell_output("#{bin}/acmos --version")
  end
end
