class Acmos < Formula
  desc "Multi-format AI proxy with combo virtual providers"
  homepage "https://github.com/charlzyx/acmos"
  url "https://github.com/charlzyx/acmos/releases/download/v0.1.3/acmos"
  sha256 "2dce8ef081b2e9728526e4c4e8ed8a0a9164d5048d74e89a5aa1002fedc4fe92"
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
    assert_match "0.1.3", shell_output("#{bin}/acmos --version")
  end
end
