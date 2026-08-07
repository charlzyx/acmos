class Acmos < Formula
  desc "Multi-format AI proxy with combo virtual providers"
  homepage "https://github.com/charlzyx/acmos"
  url "https://github.com/charlzyx/acmos/releases/download/v0.1.13/acmos"
  sha256 "659a1e3524d867b1afb32b561c6371fa41b4b15c9b1b228e99d57844665ef5b3"
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
    assert_match "0.1.13", shell_output("#{bin}/acmos --version")
  end
end
