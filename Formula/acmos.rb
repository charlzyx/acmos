class Acmos < Formula
  desc "Multi-format AI proxy with combo virtual providers"
  homepage "https://github.com/charlzyx/acmos"
  url "https://github.com/charlzyx/acmos/releases/download/v0.1.0/acmos"
  sha256 "1f095559ebc34df56229fa66dc7d3ee8c6f52f9bc22cc68af9d913ce739c36f3"
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
