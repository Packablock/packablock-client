export async function main(report: any, owner: string, repo: string) {
	const timestamp = new Date().toISOString();
	let markdown = "";

	markdown += `# 🛡️ Packablock Security Attestation Report\n\n`;
	markdown += `**Target Repository:** \`${owner}/${repo}\`\n`;
	markdown += `**Execution Time:** \`${timestamp}\`\n\n`;

	if (report.valid) {
		markdown += `### ✅ VERIFICATION PASSED\n\n`;
		markdown += `The package history chain is **cryptographically intact and 100% untampered**.\n\n`;
		markdown += `- **Total Blocks Verified:** ${report.blockCount}\n`;
		markdown += `- **Latest Block Hash:** \`${report.lastBlockHash}\`\n`;
		markdown += `- **Integrity Status:** SECURE\n\n`;
		markdown += `> [!NOTE]\n`;
		markdown += `> All dependency changes are tracked, cryptographically chained, and match the registry's cryptographic anchor. No history rewrites or split-timeline attacks were detected.\n`;
	} else {
		markdown += `### ❌ VERIFICATION FAILED (TAMPER DETECTED)\n\n`;
		markdown += `> [!CAUTION]\n`;
		markdown += `> Cryptographic mismatch or structural anomaly detected in the package history chain!\n\n`;
		markdown += `- **Reason:** ${report.reason}\n`;
		markdown += `- **Failed Block Index:** Block ${report.blockIndex !== undefined ? report.blockIndex : "N/A"}\n`;
		markdown += `- **Tampered Component:** \`${report.tamperedComponent || "N/A"}\`\n`;

		if (report.expected !== undefined || report.actual !== undefined) {
			markdown += `- **Expected Hash/Value:** \`${report.expected}\`\n`;
			markdown += `- **Actual Hash/Value:** \`${report.actual}\`\n`;
		}
	}

	console.log(markdown);
	return markdown;
}
