import fs from 'fs/promises';
import path from 'path';
import {fileURLToPath} from 'url';

import {Octokit} from '@octokit/rest';
import {ChartJSNodeCanvas} from 'chartjs-node-canvas';
import Table from 'cli-table3';

import {log, setTextColor} from './Util.js';
import ThemeManager from './ThemeManager.js';
import { ChartGenerator } from './ChartGenerator.js';

import { getBadge } from './Util.js';

const colorRanges = [
    [0, 0, 0],          // 0~9: 검은색
    [60, 60, 60],       // 10~19: 어두운 회색
    [120, 120, 120],    // 20~29: 중간 회색
    [180, 180, 180],    // 30~39: 밝은 회색
    [144, 238, 144],    // 40~49: 연두색
    [100, 200, 100],    // 50~59: 진한 연두
    [30, 144, 255],     // 60~69: 청색
    [65, 105, 225],     // 70~79: 진한 청색
    [138, 43, 226],     // 80~89: 보라색
    [186, 85, 211],     // 90~99: 연보라색
    [255, 0, 0],        // 100: 빨간색
];

const SCORE = {
    prFeatureBug: 3,
    prDoc: 2,
    prTypo: 1, // 추가: 오타 수정 PR 점수
    issueFeatureBug: 2,
    issueDoc: 1
};

const EXCLUDE_USERS = ['kyagrd', 'kyahnu'];

const CSV_HEADER = 'name,feat/bug PR,doc PR,typo PR,feat/bug issue,doc issue,total\n';

// 사용자 초기화 함수
function initParticipant(map, login) {
    if (!map.has(login)) {
        map.set(login, {
            pullRequests: {bugAndFeat: 0, doc: 0, typo: 0},
            issues: {bugAndFeat: 0, doc: 0}
        });
    }
}

class RepoAnalyzer {
    constructor(repoPath, token) {
        this.repoPaths = repoPath;
        this.token = token; // 자신의 github token
        this.participants = new Map();
        this.octokit = token ? new Octokit({auth: token}) : new Octokit(); // 토큰이 등록되었을 경우 인증, 안되었을 경우는 비인증 상태로 진행
        this.themeManager = new ThemeManager();
    }

    async validateToken() { // API 토큰 인증
        if (!this.token) {
            log('등록된 토큰이 없어 비인증 상태로 진행합니다.', 'INFO');
            return;
        }
        log('토큰 인증을 진행합니다...', 'INFO');
        try {
            await this.octokit.rest.users.getAuthenticated();
            log('토큰이 인증에 성공했습니다.', 'INFO');
        } catch (error) {
            if (error.status === 401) {
                throw new Error('Github 토큰 인증에 실패하여 프로그램을 종료합니다. 토큰이 만료되었거나 유효하지 않은 토큰입니다. Github 설정에서 새로운 토큰을 발급받아 사용해주세요.');
            } else if (error.status === 403) {
                throw new Error('Github API 요청 횟수가 초과되었습니다. 1시간 후에 다시 시도하거나, 인증된 토큰을 사용해주세요.');
            } else if (error.status === 404) {
                throw new Error('Github API 엔드포인트를 찾을 수 없습니다. Github 서비스가 정상적으로 동작하는지 확인해주세요.');
            } else {
                throw new Error(`Github 토큰 인증 중 예기치 않은 오류가 발생했습니다. 오류 상태: ${error.status}, 메시지: ${error.message}`);
            }
        }
    }

    async collectPRsAndIssues() {
        log('Collecting PRs and issues...', 'INFO');

        if (this.repoPaths.length >= 2)
            this.participants.set('total', new Map());

        let totalMap = this.participants.get('total') || {};

        // 병렬 처리를 위한 Promises map 생성
        const repoPromises = this.repoPaths.map(async (repoPath) => {
            const [owner, repo] = repoPath.split('/'); // 사용자, 저장소 이름 추출
            
            // PR, 이슈 통계 확인용 카운터
            let bugFeatPRcnt = 0, docPRcnt = 0;
            let bugFeatissueCnt = 0, docissueCnt = 0;

            this.participants.set(repo, new Map());
            let repoMap = this.participants.get(repo);
            let page = 1;
            try {
                while (true) {
                    const {data: response} = await this.octokit.rest.issues.listForRepo({ // 이슈(일반 이슈 + PR) 데이터를 요청.
                        owner,
                        repo,
                        state: 'all',
                        per_page: 100,
                        page
                    });

                    response.forEach(issue => {
                        const login = issue.user.login;
                        if (EXCLUDE_USERS.includes(login)) return; //교수님 ID 제외

                        initParticipant(repoMap, login); // 사용자 초기화
                        if (this.repoPaths.length >= 2) {
                            initParticipant(totalMap, login);
                        }

                        if (issue.pull_request !== undefined) {  // PR인 경우.
                            if (issue.pull_request.merged_at !== null) {  // PR이 병합되었는지 확인.
                                // 라벨에 따른 분류, 라벨은 문서, 기능, 버그 세 종류만 존재하며 한 이슈/PR에 하나의 라벨만 붙는다고 가정. 라벨이 없다면 개수를 추가하지 않음.
                                if (issue.labels.length !== 0 && issue.labels[0].name === 'documentation') {
                                    repoMap.get(login).pullRequests.doc += 1;
                                    if (this.repoPaths.length >= 2) totalMap.get(login).pullRequests.doc += 1;
                                    docPRcnt++;
                                } else if (issue.labels.length !== 0 && issue.labels[0].name === 'typo') {
                                    repoMap.get(issue.user.login).pullRequests.typo += 1;
                                    if (this.repoPaths.length >= 2) totalMap.get(issue.user.login).pullRequests.typo += 1;
                                    docPRcnt++;
                                } else if (issue.labels.length !== 0) {
                                    repoMap.get(login).pullRequests.bugAndFeat += 1;
                                    if (this.repoPaths.length >= 2) totalMap.get(login).pullRequests.bugAndFeat += 1;
                                    bugFeatPRcnt++;
                                }
                            }
                        } else { // 이슈인 경우.
                            if ( // 반려된 이슈들을 제외시킴.
                                issue.state_reason === 'completed' ||  // 정상적으로 닫힌 이슈.
                                issue.state_reason == null ||         // 아직 열려있는 이슈는 null로 표시됨.
                                issue.state_reason === 'reopened'      // 닫혔던 이슈가 다시 열린 경우.
                            ) {
                                if (issue.labels.length !== 0 && issue.labels[0].name === 'documentation') {
                                    repoMap.get(issue.user.login).issues.doc += 1;
                                    if (this.repoPaths.length >= 2) totalMap.get(issue.user.login).issues.doc += 1;
                                    docissueCnt++;
                                } else if (issue.labels.length !== 0) {
                                    repoMap.get(issue.user.login).issues.bugAndFeat += 1;
                                    if (this.repoPaths.length >= 2) totalMap.get(issue.user.login).issues.bugAndFeat += 1;
                                    bugFeatissueCnt++;
                                }
                            }
                        }
                    });

                    if (response.length < 100) { // 마지막 페이지라면 루프를 탈출.
                        break;
                    }
                    page++; // 다음 페이지로 넘어감.
                }
                
                // PR, 이슈 통계 확인용 log
                log(`\n***${repo}***\n`, 'DEBUG');
                log(`bug and Feat PRs : ${bugFeatPRcnt}`, 'DEBUG');
                log(`doc PRs : ${docPRcnt}`, 'DEBUG');
                log(`bug and Feat issues : ${bugFeatissueCnt}`, 'DEBUG');
                log(`doc issues : ${docissueCnt}\n`, 'DEBUG');
                
            } catch (error) {
                const status = error?.status;
                if (status === 404) {
                    throw new Error("레포지토리 주소가 잘못되었습니다.");
                } else if ((status === 403 || status === 429) && error.message.includes('API rate limit exceeded')) {
                    throw new Error("⚠️ GitHub API 사용 횟수 제한에 도달했습니다 ⚠️\n" +
                        "다음 방법 중 하나를 선택하여 해결할 수 있습니다:\n" +
                        "1. GitHub 토큰을 사용하여 실행 (-a 옵션 사용)\n" +
                        "2. 캐시된 데이터 사용 (-c 옵션 사용)\n" +
                        "3. 잠시 후 다시 시도");
                } else if (status === undefined) {
                    throw new Error(`네트워크 연결 문제 또는 GitHub API 서버 응답 오류가 발생했습니다.\n오류 내용: ${error.message}\n네트워크 연결을 확인하고 잠시 후 다시 시도해주세요.`);
                } else {
                    throw new Error(`GitHub API 요청 중 오류가 발생했습니다.\n상태 코드: ${status}\n오류 내용: ${error.message}\n\n문제가 지속되면 GitHub 상태 페이지(https://www.githubstatus.com)에서 서비스 상태를 확인해주세요.`);
                }
            }
        });

        await Promise.all(repoPromises);
    }

    calculateAverageScore(allRepoScores) {
        allRepoScores.forEach((repoScores, repoName) => {
            const values = repoScores.map(item => item[1]);
            if (values.length === 0) {
                log('참가자가 없어 평균을 계산할 수 없습니다.\n', 'INFO');
            }

            const total = values.reduce((sum, val) => sum + val, 0);
            const average = total / values.length;

            log(`${repoName} Average Score: ${average.toFixed(2)}\n`, 'INFO');
            return average;
        });
    }

    /**
     * 활동 수에 따라 조정된 PR과 이슈 개수를 계산합니다.
     * @param {number} prFeature - 기능/버그 PR 개수
     * @param {number} prDoc - 문서 PR 개수
     * @param {number} prTypo - 오타 수정 PR 개수
     * @param {number} issueFeature - 기능/버그 이슈 개수
     * @param {number} issueDoc - 문서 이슈 개수
     * @returns {Object} 조정된 PR과 이슈 개수
     */
    _calculateAdjustedCounts(prFeature, prDoc, prTypo, issueFeature, issueDoc) {
        const totalPR = prFeature + prDoc + prTypo;
        const totalIssue = issueFeature + issueDoc;

        // 활동이 전혀 없는 경우
        if (totalPR === 0 && totalIssue === 0) {
            return {
                pr: { feature: 0, doc: 0, typo: 0 },
                issue: { feature: 0, doc: 0 }
            };
        }

        // 복수의 활동이 있는 경우 (PR이나 이슈가 2개 이상)
        if ((prFeature > 0 || prDoc > 0 || prTypo > 0) && (totalPR > 1 || totalIssue > 1)) {
            const tempPRFeature = (prFeature === 0 && prDoc > 0) ? 1 : prFeature;
            const validPR = tempPRFeature + Math.min(prDoc, 3 * tempPRFeature) + Math.min(prTypo, 3 * tempPRFeature);
            const validIssue = Math.min(issueFeature + issueDoc, 4 * validPR);

            return {
                pr: {
                    feature: prFeature,
                    doc: Math.min(prDoc, 3 * tempPRFeature),
                    typo: Math.min(prTypo, 3 * tempPRFeature)
                },
                issue: {
                    feature: Math.min(issueFeature, validIssue),
                    doc: validIssue - Math.min(issueFeature, validIssue)
                }
            };
        }

        // 단일 활동만 있는 경우
        return {
            pr: { feature: prFeature, doc: prDoc, typo: prTypo },
            issue: { feature: issueFeature, doc: issueDoc }
        };
    }

    /**
     * 조정된 개수를 바탕으로 점수를 계산합니다.
     * @param {Object} counts - 조정된 PR과 이슈 개수
     * @returns {Object} 계산된 점수
     */
    _calculateScoresFromCounts(counts) {
        return {
            pr: {
                feature: counts.pr.feature * SCORE.prFeatureBug,
                doc: counts.pr.doc * SCORE.prDoc,
                typo: counts.pr.typo * SCORE.prTypo
            },
            issue: {
                feature: counts.issue.feature * SCORE.issueFeatureBug,
                doc: counts.issue.doc * SCORE.issueDoc
            }
        };
    }

    /**
     * 개별 참여자의 점수를 계산합니다.
     * @param {string} participant - 참여자 ID
     * @param {Object} activities - 참여자의 활동 정보
     * @returns {Array} 참여자의 점수 정보 배열
     */
    _calculateParticipantScore(participant, activities) {
        // 1. 기본 활동 수치 추출
        const prFeature = activities.pullRequests.bugAndFeat || 0;
        const prDoc = activities.pullRequests.doc || 0;
        const prTypo = activities.pullRequests.typo || 0;
        const issueFeature = activities.issues.bugAndFeat || 0;
        const issueDoc = activities.issues.doc || 0;

        // 2. 조정된 개수 계산
        const adjustedCounts = this._calculateAdjustedCounts(
            prFeature, prDoc, prTypo, issueFeature, issueDoc
        );
        
        // 3. 점수 계산
        const scores = this._calculateScoresFromCounts(adjustedCounts);
        
        // 4. 총점 계산
        const totalScore = 
            Object.values(scores.pr).reduce((sum, score) => sum + score, 0) +
            Object.values(scores.issue).reduce((sum, score) => sum + score, 0);

        return [
            participant,
            scores.pr.feature,
            scores.pr.doc,
            scores.pr.typo,
            scores.issue.feature,
            scores.issue.doc,
            totalScore
        ];
    }

    /**
     * 전체 저장소의 점수를 계산하는 메인 함수
     * @returns {Map} 저장소별 참여자 점수 정보
     */
    calculateScores() {
        const allRepoScores = new Map();

        this.participants.forEach((repoActivities, repoName) => {
            const repoScores = Array.from(repoActivities.entries())
                .map(([participant, activities]) => 
                    this._calculateParticipantScore(participant, activities)
                )
                .sort((a, b) => b[6] - a[6]); // 총점 기준 내림차순 정렬

            allRepoScores.set(repoName, repoScores);
        });

        return allRepoScores;
    }

    async updateUserInfo(allRepoScores) {
        let usersInfo = {};
        try {
            await fs.access('user_info.json', fs.constants.R_OK);
            const data = await fs.readFile('user_info.json', 'utf8');
            usersInfo = JSON.parse(data);
            log('Loaded user_info.json', 'debug');
        } catch {
            log('user_info.json not found, creating new file...', 'info');
        }

        for (const [_, repoScores] of allRepoScores) {
            for (let usersData of repoScores) {
                if (!usersInfo[usersData[0]]) {
                    try {
                        log(`Fetching user info for ${usersData[0]}...`, 'debug');
                        const {data: response} = await this.octokit.users.getByUsername({
                            username: usersData[0],
                        });
                        usersInfo[usersData[0]] = response.name || '*';
                        log(`Added ${usersData[0]}: ${usersInfo[usersData[0]]} to user_info.json`, 'debug');
                    } catch (error) {
                        if (error.status === 403 || error.status === 429) {
                            log('GitHub API rate limit exceeded. Use token (-a) or cache (-c).', 'error');
                            throw new Error('API rate limit exceeded');
                        }
                        log(`Failed to fetch user info for ${usersData[0]}: ${error.message}`, 'error');
                        usersInfo[usersData[0]] = '*';
                    }
                }
            }
        }

        log('Saving user_info.json...', 'debug');
        await fs.writeFile('user_info.json', JSON.stringify(usersInfo, null, 4));
        log('Updated user_info.json', 'info');
    }

    async transformUserIdToName(allRepoScores) {
        const data = await fs.readFile('user_info.json', 'utf8');
        const usersInfo = JSON.parse(data);

        let newAllRepoScores = structuredClone(allRepoScores);

        for (const [_, repoScores] of newAllRepoScores) {
            for (let usersData of repoScores) {
                if (usersData[0] != null) { // 등록된 이름이 null인경우에는 치환하지 않음.
                    usersData[0] = usersInfo[usersData[0]];  // id를 id(이름) 으로 바꾸어 저장.
                }
            }
        }
        return newAllRepoScores;
    }

    async generateTable(allRepoScores, output) {
        const promises = Array.from(allRepoScores).map(async ([repoName, repoScores]) => {
            let theme = this.themeManager.getCurrentTheme();
            
            // 테마 null 체크
            if (!theme || !theme.table) {
                console.error('테이블 테마를 불러올 수 없습니다. 기본 설정을 사용합니다.');
                theme = {
                    table: {
                        head: ['yellow'],
                        border: ['gray']
                    }
                };
            }
            
            const table = new Table({
                head: ['참가자', 'feat/bug PR 점수', 'doc PR 점수', 'typo PR 점수', 'feat/bug 이슈 점수', 'doc 이슈 점수', '총점', '참여율(%)'],
                colWidths: [20, 16, 12, 12, 16, 12, 10, 11],
                style: { 
                    head: theme.table.head,
                    border: theme.table.border
                }
            });

            // 리포지토리 전체 합(= 모든 기여자의 totalScore 합)
            const totalScore = repoScores.reduce((sum, row) => sum + row[6], 0); // 변경: totalScore 인덱스 6으로 조정

            // 텍스트 파일로 저장하기 위해 문자열 준비
            repoScores.forEach(([name, p_fb_score, p_d_score, p_t_score, i_fb_score, i_d_score, total]) => { // 변경: p_t_score 추가
                const rate = totalScore > 0 ? ((total / totalScore) * 100).toFixed(2) : '0.00';
                //뱃지
                const badge = getBadge(total);
                const nameWithBadge = `${badge} ${name}`;
                // CLI에 표시될 테이블 행
                table.push([
                    nameWithBadge,
                    p_fb_score,
                    p_d_score,
                    p_t_score, // 추가
                    i_fb_score,
                    i_d_score,
                    total,
                    `${rate}%`
                ]);
            });

            const filePath = path.join(output, `${repoName}.txt`);
            
            // ANSI 색상 코드를 제거한 텍스트를 저장
            // 정규식을 사용하여 ANSI 이스케이프 시퀀스 제거
            const stripAnsi = (str) => {
                // ANSI 이스케이프 시퀀스 제거 정규식
                return str.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
            };
            
            await fs.writeFile(filePath, stripAnsi(table.toString()), 'utf-8');
            log(`점수 집계 텍스트 파일이 생성되었습니다: ${filePath}`, 'INFO');
        });

        await Promise.all(promises);
    }

    /**
     * 저장소별 차트를 생성합니다.
     * @param {Map} allRepoScores - 모든 저장소의 점수 정보
     * @param {string} outputDir - 출력 디렉토리
     */
    async generateChart(allRepoScores, outputDir = '.') {
        try {
            const chartGenerator = new ChartGenerator(undefined, this.themeManager.getCurrentTheme());
            
            for (const [repoName, repoScores] of allRepoScores) {
                try {
                    await chartGenerator.generateChart(repoName, repoScores, outputDir);
                } catch (error) {
                    log(`${repoName} 차트 생성 실패: ${error.message}`, 'ERROR');
                }

                
                // 기본 색상 반환
                return 'rgb(169, 169, 169)'; // 기본 회색
            });

            const now = new Date();
            const dateStr = now.toLocaleString();

            const configuration = {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Score',
                        data: data,
                        backgroundColor: barColors,
                        borderColor: barColors.map(color => {
                            if (typeof color === 'string' && color.startsWith('rgb')) {
                                return color.replace('rgb', 'rgba').replace(')', ', 0.6)');
                            }
                            return 'rgba(169, 169, 169, 0.6)'; // 기본 회색 테두리
                        }),
                    }],
                },
                options: {
                    responsive: false,
                    indexAxis: 'y',
                    plugins: {
                        title: {
                            display: true,
                            text: [`Contribution Score by Participant`, `Generated at ${dateStr}`],
                            color: theme.chart.textColor,
                            font: {
                                size: 16,
                                weight: 'bold'
                            }
                        },
                        subtitle: {
                            display: true,
                            text: `Total number of student : ${participantCount}`,
                            align: 'end',
                            color: theme.chart.textColor,
                            font: {
                                size: 12
                            },
                            padding: {
                                top: 0,
                                bottom: 10
                            }
                        },
                        datalabels: {
                            color: theme.chart.textColor,
                            font: {
                                weight: 'bold'
                            },
                            anchor: 'end',
                            align: 'end',
                            offset: 4
                        }
                    },
                    scales: {
                        x: {
                            grid: {
                                color: theme.chart.gridColor
                            },
                            ticks: {
                                autoSkip: false,
                                color: theme.chart.textColor
                            },
                            max: xAxisMax  // 동적으로 계산된 최댓값 설정
                        },
                        y: {
                            grid: {
                                display: false
                            },
                            ticks: {
                                color: theme.chart.textColor
                            },
                            beginAtZero: true
                        }
                    }

                }
            };

            const buffer = await chartJSNodeCanvas.renderToBuffer(configuration);
            const filePath = path.join(outputDir, `${repoName}_chart.png`);
            await fs.writeFile(filePath, buffer);
            log(`차트 이미지가 저장되었습니다: ${filePath}`, 'INFO');
            }
        } catch (error) {
            log(`차트 생성 중 오류 발생: ${error.message}`, 'ERROR');
            throw error;
        }
    }

    async generateScoreCsv(repoName, repoScores, outputDir) {
        let csvContent = CSV_HEADER;
        let totalScore = 0;

        repoScores.forEach(([name, prFeat, prDoc, prTypo, issueFeat, issueDoc, score]) => {
            csvContent += `${name},${prFeat},${prDoc},${prTypo},${issueFeat},${issueDoc},${score}\n`;
            totalScore += score;
        });

        const filePath = path.join(outputDir, `${repoName}_score.csv`);
        await fs.writeFile(filePath, csvContent);
        log(`점수 집계 CSV 파일이 생성되었습니다: ${filePath}`, '생성');
    }

    async generateCountCsv(repoName, repoActivities, outputDir) {
        let csvContent = CSV_HEADER;
        let totalCount = 0;

        for (const [participant, activities] of repoActivities.entries()) {
            const p_fb = activities.pullRequests.bugAndFeat || 0;
            const p_d = activities.pullRequests.doc || 0;
            const p_t = activities.pullRequests.typo || 0;
            const i_fb = activities.issues.bugAndFeat || 0;
            const i_d = activities.issues.doc || 0;
            const count = p_fb + p_d + p_t + i_fb + i_d;

            csvContent += `${participant},${p_fb},${p_d},${p_t},${i_fb},${i_d},${count}\n`;
            totalCount += count;
        }

        const filePath = path.join(outputDir, `${repoName}_count.csv`);
        await fs.writeFile(filePath, csvContent);
        log(`활동 개수 CSV 파일이 생성되었습니다: ${filePath}`, 'INFO');
    }

    async generateCsv(allRepoScores, outputDir = '.') {
        const promises = Array.from(allRepoScores).map(async ([repoName, repoScores]) => {
            // 점수 CSV 생성
            await this.generateScoreCsv(repoName, repoScores, outputDir);

            // 활동 개수 CSV 생성
            const repoActivities = this.participants.get(repoName);
            if (repoActivities) {
                await this.generateCountCsv(repoName, repoActivities, outputDir);
            }
        });

        await Promise.all(promises);
    }

    setTheme(themeName) {
        const result = this.themeManager.setTheme(themeName);
        if (result) {
            const theme = this.themeManager.getCurrentTheme();
            if (theme && theme.colors) {
                setTextColor(theme.colors.text);
            } else {
                console.error(`테마 '${themeName}'의 색상 정보를 불러올 수 없습니다.`);
            }
        }
        return result;
    }

    log(message) {
        console.log(this.themeManager.applyTextTheme(message));
    }
}

export default RepoAnalyzer;
