/* jshint node: true, esversion: 6, eqeqeq: true, latedef: true, undef: true, unused: true */
"use strict";

var config = require('config');
var mongoose = require('mongoose');

mongoose.connect(config.get('server.mongodb'));

var userSchema = new mongoose.Schema({
    alias: String,
    steamID: String,
    setUp: {
        type: Boolean,
        default: false
    },
    currentRating: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Rating'
    }
});

var gameSchema = new mongoose.Schema({
    status: {type: String, enum: ['assigning', 'launching', 'live', 'aborted', 'completed']},
    date: Date,
    captains: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        faction: String
    }],
    map: String,
    players: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        role: String,
        team: Number,
        origin: String,
        replaced: {
            type: Boolean,
            default: false
        }
    }],
    server: String,
    results: [{
        score: [Number],
        links: [{
            type: {type: String},
            url: String
        }]
    }],
    choices: [{
        type: {type: String},
        method: String,
        captain: Number,
        faction: String,
        role: String,
        player: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User'
        },
        map: String
    }],
    pool: {
        maps: [String],
        players: [{
            user: {
                type: mongoose.Schema.Types.ObjectId,
                ref: 'User'
            },
            roles: [String]
        }]
    }
});

var ratingSchema = new mongoose.Schema({
    user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    date: Date,
    game: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Game'
    },
    before: {
        rating: Number,
        deviation: Number
    },
    after: {
        rating: Number,
        deviation: Number
    }
});

module.exports = {
    User: mongoose.model('User', userSchema),
    Game: mongoose.model('Game', gameSchema),
    Rating: mongoose.model('Rating', ratingSchema)
};
