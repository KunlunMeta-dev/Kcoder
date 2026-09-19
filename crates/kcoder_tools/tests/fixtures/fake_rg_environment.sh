#!/bin/sh
printf 'env.txt:1:home=%s,pwd=%s\n' "${HOME-unset}" "$PWD"
