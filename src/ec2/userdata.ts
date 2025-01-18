import { ConfigInterface } from "../config/config";
import * as github from "@actions/github";
import { GithubClient } from "../github/github";

export class UserData {
  config: ConfigInterface;

  constructor(config: ConfigInterface) {
    this.config = config;
  }

  async getUserData(): Promise<string> {
    const ghClient = new GithubClient(this.config);
    const githubActionRunnerVersion = await ghClient.getRunnerVersion();
    const runnerRegistrationToken = await ghClient.getRunnerRegistrationToken();
    if (!this.config.githubActionRunnerLabel)
      throw Error("failed to object job ID for label");

    // This is to handle cleanup of orphaned instances or job cancelations
    var jobStartIdleTimeoutTask = "echo 'No idle timeout set'";
    if (Number(this.config.githubJobStartTtlSeconds) > 0) {
      jobStartIdleTimeoutTask = `
        timeout=${this.config.githubJobStartTtlSeconds};
        found=0;
        (
          while ((timeout-- > 0)); do
            [[ -d "_work" ]] && { found=1; break; };
            sleep 1;
          done;
          [[ $found -eq 0 ]] && ../shutdown_now_script.sh
        ) &
      `;
    }

    // shutdown_now_script.sh => used for forceful terminate
    // shutdown_script.sh => used for graceful termination with a delay allowing for log uploads
    const cmds = [
      "#!/bin/bash",
      // Create the runner user if it doesn't exist
      `if ! id -u runner >/dev/null 2>&1; then sudo useradd -m runner; fi`,

      // Prepare shutdown scripts as the `runner` user
      "sudo -u runner bash <<'EOF'",
      "CURRENT_PATH=$(pwd)",
      'CURRENT_PATH="${CURRENT_PATH%/}"',

      // Shutdown script
      `echo "./config.sh remove --token ${runnerRegistrationToken.token} || true" > $CURRENT_PATH/shutdown_script.sh`,
      `echo "shutdown -P +1" >> $CURRENT_PATH/shutdown_script.sh`,
      "chmod +x $CURRENT_PATH/shutdown_script.sh",

      // Immediate shutdown script
      `echo "./config.sh remove --token ${runnerRegistrationToken.token} || true" > $CURRENT_PATH/shutdown_now_script.sh`,
      `echo "shutdown -h now" >> $CURRENT_PATH/shutdown_now_script.sh`,
      "chmod +x $CURRENT_PATH/shutdown_now_script.sh",

      // Environment variable for job completion hook
      `echo "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$CURRENT_PATH/shutdown_script.sh" > $CURRENT_PATH/.env`,
      "EOF",

      // Create and navigate to actions-runner directory as `runner` user
      "sudo -u runner bash <<'EOF'",
      "mkdir -p ~/actions-runner && cd ~/actions-runner",

      // Determine architecture
      'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac',
      'export RUNNER_ARCH=${ARCH}',

      // Download and extract GitHub Actions runner
      `curl -O -L https://github.com/actions/runner/releases/download/v${githubActionRunnerVersion}/actions-runner-linux-${RUNNER_ARCH}-${githubActionRunnerVersion}.tar.gz`,
      "tar xzf ./actions-runner-linux-${RUNNER_ARCH}-${githubActionRunnerVersion}.tar.gz",

      // Install dependencies if using yum
      '[ -n "$(command -v yum)" ] && sudo yum install libicu -y',

      // Configure the runner
      `./config.sh --unattended --ephemeral --url https://github.com/${github.context.repo.owner}/${github.context.repo.repo} --token ${runnerRegistrationToken.token} --labels ${this.config.githubActionRunnerLabel} --name ${this.config.githubJobId}-$(hostname)-ec2 ${this.config.githubActionRunnerExtraCliArgs}`,

      // Set runner environment variable
      `echo "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$HOME/shutdown_script.sh" > .env`,

      // Start the runner
      "./run.sh",
      "EOF",
    ];


    return Buffer.from(cmds.join("\n")).toString("base64");
  }
}
