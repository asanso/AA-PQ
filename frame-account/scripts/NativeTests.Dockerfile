FROM aa-pq-nethermind:verify500k-build
ENV DOTNET_PROCESSOR_COUNT=2
RUN dotnet restore src/Nethermind/Nethermind.Evm.Test/Nethermind.Evm.Test.csproj
COPY native-tests.cs.txt /daisugi-tests.txt
RUN target=src/Nethermind/Nethermind.Evm.Test/FrameTxValidationPrefixSimulationTests.cs && \
    sed '/    private ISpecProvider _specProvider;/r /daisugi-tests.txt' "$target" > /tmp/daisugi-tests.cs && \
    cp /tmp/daisugi-tests.cs "$target" && \
    dotnet build src/Nethermind/Nethermind.Evm.Test/Nethermind.Evm.Test.csproj -c release --no-restore
ENTRYPOINT ["dotnet", "src/Nethermind/artifacts/bin/Nethermind.Evm.Test/release/Nethermind.Evm.Test.dll"]
CMD ["--filter", "FullyQualifiedName~DaisugiSphincsFactory"]
