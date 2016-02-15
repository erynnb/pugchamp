'use strict';

const _ = require('lodash');
const co = require('co');
const config = require('config');
const distributions = require('distributions');
const hbs = require('hbs');
const math = require('mathjs');

module.exports = function(app, chance, database, io, self) {
    function calculatePredictionInterval(samples) {
        let n = _.size(samples);

        if (n > 1) {
            let mean = math.mean(samples);
            let deviation = math.std(samples);

            let distribution = new distributions.Studentt(n - 1);

            let low = mean + (distribution.inv(0.16) * deviation * math.sqrt(1 + (1 / n)));
            let high = mean + (distribution.inv(0.84) * deviation * math.sqrt(1 + (1 / n)));

            return {
                low: low >= 0 ? low : 0,
                center: mean,
                high: high <= 1 ? high : 1
            };
        }
        else if (n === 1) {
            let mean = math.mean(samples);

            return {
                low: null,
                center: mean,
                high: null
            };
        }
        else {
            return {
                low: null,
                center: null,
                high: null
            };
        }
    }

    const ROLES = config.get('app.games.roles');
    const UPDATE_PLAYER_CACHE_DEBOUNCE_MAX_WAIT = 5000;
    const UPDATE_PLAYER_CACHE_DEBOUNCE_WAIT = 1000;

    var playerListCache;
    var playerListFilteredCache;

    var updatePlayerCache = _.debounce(function updatePlayerCache() {
        let players = _.orderBy(self.getCachedUsers(), [function(player) {
            return player.stats.rating.low;
        }, function(player) {
            return player.stats.captainScore ? player.stats.captainScore.low : null;
        }], ['desc', 'desc']);

        playerListCache = _.map(players, player => ({
            id: player.id,
            alias: player.alias,
            steamID: player.steamID,
            ratingMean: math.round(player.stats.rating.mean),
            ratingDeviation: math.round(player.stats.rating.deviation),
            ratingLowerBound: math.round(player.stats.rating.low),
            ratingUpperBound: math.round(player.stats.rating.high),
            captainScore: player.stats.captainScore && _.isNumber(player.stats.captainScore.low) ? math.round(player.stats.captainScore.low, 3) : null
        }));

        playerListFilteredCache = _(players).filter(function(player) {
            if (!player.authorized) {
                return false;
            }

            if (player.stats.roles) {
                for (let stat of player.stats.roles) {
                    if (stat.number > 0) {
                        return true;
                    }
                }
            }

            if (player.stats.draft) {
                for (let stat of player.stats.draft) {
                    if (stat.type === 'captain' && stat.number > 0) {
                        return true;
                    }
                }
            }

            return false;
        }).map(player => ({
            id: player.id,
            alias: player.alias,
            steamID: player.steamID,
            ratingMean: math.round(player.stats.rating.mean),
            ratingDeviation: math.round(player.stats.rating.deviation),
            ratingLowerBound: math.round(player.stats.rating.low),
            ratingUpperBound: math.round(player.stats.rating.high),
            captainScore: player.stats.captainScore && _.isNumber(player.stats.captainScore.low) ? math.round(player.stats.captainScore.low, 3) : null
        })).value();
    }, UPDATE_PLAYER_CACHE_DEBOUNCE_WAIT, {
        maxWait: UPDATE_PLAYER_CACHE_DEBOUNCE_MAX_WAIT
    });

    self.on('cachedUserUpdated', function() {
        updatePlayerCache();
    });

    self.updatePlayerStats = co.wrap(function*(playerID) {
        let player = yield database.User.findById(playerID);

        let captainGames = yield database.Game.find({
            'teams.captain': player.id,
            'status': 'completed',
            'score': {
                $exists: true
            }
        });

        let scores = _.map(captainGames, function(game) {
            let totalScore = math.sum(...game.score);

            if (totalScore > 0) {
                let teamIndex = _.findIndex(game.teams, function(team) {
                    return self.getDocumentID(team.captain) === player.id;
                });

                return game.score[teamIndex] / totalScore;
            }
            else {
                return 0.5;
            }
        });

        player.stats.captainScore = calculatePredictionInterval(scores);

        player.stats.draft = yield _(ROLES).keys().map(role => database.Game.find({
            'draft.choices': {
                $elemMatch: {
                    'type': 'playerPick',
                    'role': role,
                    'player': player.id
                }
            }
        }).count().exec().then(count => ({
            type: 'picked',
            role: role,
            number: count
        }))).concat(database.Game.count({
            'teams.captain': player.id
        }).count().exec().then(count => ({
            type: 'captain',
            number: count
        })), database.Game.find({
            $nor: [{
                'draft.choices': {
                    $elemMatch: {
                        'type': 'playerPick',
                        'player': player.id
                    }
                }
            }, {
                'teams.captain': player.id
            }],
            'draft.pool.players.user': player.id
        }).count().exec().then(count => ({
            type: 'undrafted',
            number: count
        }))).value();

        let rating = yield database.Rating.findOne({
            user: player.id
        }).sort('-date').exec();

        if (rating) {
            player.stats.rating.mean = rating.after.mean;
            player.stats.rating.deviation = rating.after.deviation;
        }

        player.stats.roles = yield _(ROLES).keys().map(role => database.Game.find({
            'teams.composition': {
                $elemMatch: {
                    'role': role,
                    'players.user': player.id
                }
            }
        }).count().exec().then(count => ({
            role: role,
            number: count
        }))).value();

        yield player.save();

        yield self.updateCachedUser(player.id);
    });

    hbs.registerHelper('draftStatToRow', function(stat) {
        if (stat.type === 'captain') {
            return JSON.stringify(['Captain', stat.number]);
        }
        else if (stat.type === 'picked') {
            return JSON.stringify(['Picked ' + ROLES[stat.role].name, stat.number]);
        }
        else if (stat.type === 'undrafted') {
            return JSON.stringify(['Undrafted', stat.number]);
        }
    });
    hbs.registerHelper('ratingStatToRow', function(stat) {
        return '[new Date("' + stat.date + '"),' + stat.after.mean + ',' + stat.after.low + ',' + stat.after.high + ']';
    });
    hbs.registerHelper('roleStatToRow', function(stat) {
        return JSON.stringify([ROLES[stat.role].name, stat.number]);
    });

    app.get('/player/:steam', co.wrap(function*(req, res) {
        let user = yield database.User.findOne({
            steamID: req.params.steam
        }).exec();

        if (!user) {
            res.sendStatus(404);
            return;
        }

        let games = yield database.Game.find({
            $or: [{
                'teams.captain': user.id
            }, {
                'teams.composition.players': {
                    $elemMatch: {
                        user: user.id
                    }
                }
            }]
        }).sort('-date').populate('teams.captain').exec();

        let ratings = yield database.Rating.find({
            'user': user.id
        }).populate('game', 'date').exec();

        let restrictions = yield database.Restriction.find({
            user: user.id
        }).exec();

        res.render('player', {
            user: user.toObject(),
            games: _(games).map(function(game) {
                let revisedGame = _.omit(game.toObject(), 'draft', 'server', 'links');

                if (self.getDocumentID(user) === self.getDocumentID(game.teams[0].captain)) {
                    revisedGame.reverseTeams = false;
                }
                else if (self.getDocumentID(user) === self.getDocumentID(game.teams[1].captain)) {
                    revisedGame.reverseTeams = true;
                }
                else {
                    let gamePlayerInfo = self.getGamePlayerInfo(game, user.id);
                    let team = _.indexOf(game.teams, gamePlayerInfo.team);

                    revisedGame.reverseTeams = team !== 0;
                }

                return revisedGame;
            }).value(),
            ratings: _(ratings).map(rating => rating.toObject()).sortBy('date').value(),
            restrictions: _(restrictions).map(restriction => restriction.toObject()).orderBy(['active', 'expires'], ['desc', 'desc']).value()
        });
    }));

    app.get('/players', function(req, res) {
        res.render('playerList', {
            players: !req.user || !req.user.admin ? playerListFilteredCache : playerListCache
        });
    });
};
