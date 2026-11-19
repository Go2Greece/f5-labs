#!/bin/sh
# Stamps a build number into the pages so the browser fetches fresh files and the
# running version is visible in the lab footer. Run before each commit.
V=$(TZ=Europe/Athens date +%m%d-%H%M)
echo "$V" > public/version.txt
for f in public/lab.html public/course.html; do
  sed -i -E "s#/app\.css(\?v=[0-9-]+)?#/app.css?v=$V#; s#/lab\.js(\?v=[0-9-]+)?#/lab.js?v=$V#" "$f"
done
sed -i -E "s#data-build=\"[^\"]*\"#data-build=\"$V\"#" public/lab.html
echo "build $V"
